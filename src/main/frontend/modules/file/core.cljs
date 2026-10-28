(ns frontend.modules.file.core
  (:require [clojure.string :as string]
            [frontend.config :as config]
            [frontend.s01 :as s01]
            [frontend.s01-metadata :as metadata]
            [frontend.s01-state :as s01-state]
            [frontend.util.drawer :as drawer]
            [frontend.modules.outliner.tree :as tree]
            [frontend.date :as date]
            [frontend.db :as db]
            [frontend.db.model :as model]
            [frontend.db.utils :as db-utils]
            [frontend.handler.file :as file-handler]
            [frontend.modules.file.uprint :as up]
            [frontend.state :as state]
            [frontend.util.fs :as fs-util]
            [frontend.util.property :as property]
            [logseq.common.path :as path]))

(defn- indented-block-content
  [content spaces-tabs]
  (let [lines (string/split-lines content)]
    (string/join (str "\n" spaces-tabs) lines)))

(defn- content-with-collapsed-state
  "Only accept nake content (without any indentation)"
  [format content collapsed?]
  (cond
    collapsed?
    (property/insert-property format content :collapsed true)

    ;; Don't check properties. Collapsed is an internal state log as property in file, but not counted into properties
    (false? collapsed?)
    (property/remove-property format :collapsed content)

    :else
    content))

(defn without-collapsed-property
  "Remove legacy collapsed only from the block's property header, never code/body examples."
  [content]
  (let [lines (string/split-lines content)
        property-line? #(boolean (and % (re-find #"^\s*[^\s:]+::(?:\s|$)" %)))
        [title tail] (if (property-line? (first lines)) [[] lines] [(take 1 lines) (rest lines)])
        [properties body] (split-with property-line? tail)]
    (if (and (not (re-find #"^\s*(?:```|~~~)" (or (first lines) "")))
             (some #(re-find #"(?i)^\s*collapsed::(?:\s|$)" %) properties))
      (string/join "\n" (concat title (remove #(re-find #"(?i)^\s*collapsed::(?:\s|$)" %) properties) body))
      content)))

(defn transform-content
  [{:block/keys [collapsed? format pre-block? content left page parent properties] :as b} level {:keys [heading-to-list?]}]
  (let [block-ref-not-saved? (and (seq (:block/_refs (db/entity (:db/id b))))
                                  (not (string/includes? content (str (:block/uuid b)))))
        heading (:heading properties)
        markdown? (= :markdown format)
        content (if (and markdown? (s01/enabled?)) (metadata/source-content b) content)
        content (cond-> (or content "")
                  (and markdown? (s01/enabled?)) without-collapsed-property)
        pre-block? (or pre-block?
                       (and (= page parent left) ; first block
                            markdown?
                            (string/includes? (first (string/split-lines content)) ":: ")))
        content (cond
                  pre-block?
                  (let [content (string/trim content)]
                    (str content "\n"))

                  :else
                  (let [
                        ;; first block is a heading, Markdown users prefer to remove the `-` before the content
                        markdown-top-heading? (and markdown?
                                                   (= parent page left)
                                                   (number? heading))
                        [prefix spaces-tabs]
                        (cond
                          (= format :org)
                          [(->>
                            (repeat level "*")
                            (apply str)) ""]

                          markdown-top-heading?
                          ["" ""]

                          :else
                          (let [level (if (and heading-to-list? heading)
                                        (if (> heading 1)
                                          (dec heading)
                                          heading)
                                        level)
                                spaces-tabs (->>
                                             (repeat (dec level) (state/get-export-bullet-indentation))
                                             (apply str))]
                            [(str spaces-tabs "-") (str spaces-tabs "  ")]))
                        content (if heading-to-list?
                                  (-> (string/replace content #"^\s?#+\s+" "")
                                      (string/replace #"^\s?#+\s?$" ""))
                                  content)
                        content (if (and markdown? (s01/enabled?))
                                  content
                                  (content-with-collapsed-state format content collapsed?))
                        new-content (indented-block-content (string/trim content) spaces-tabs)
                        sep (if (or markdown-top-heading?
                                    (string/blank? new-content))
                              ""
                              " ")]
                    (str prefix sep new-content)))
        content (if (and block-ref-not-saved? (not (s01/enabled?)))
                  (property/insert-property format content :id (str (:block/uuid b)))
                  content)]
    content))


(defn- tree->file-content-aux
  [tree {:keys [init-level] :as opts}]
  (let [block-contents (transient [])]
    (loop [[f & r] tree level init-level]
      (if (nil? f)
        (->> block-contents persistent! flatten (remove nil?))
        (let [page? (nil? (:block/page f))
              content (if page? nil (transform-content f level opts))
              new-content
              (if-let [children (seq (:block/children f))]
                     (cons content (tree->file-content-aux children {:init-level (inc level)}))
                     [content])]
          (conj! block-contents new-content)
          (recur r level))))))

(defn tree->file-content
  [tree opts]
  (->> (tree->file-content-aux tree opts) (string/join "\n")))


(def init-level 1)

(defn- transact-file-tx-if-not-exists!
  [page-block ok-handler]
  (when (and (state/get-current-repo)
             (:block/name page-block))
    (let [format (name (get page-block :block/format
                            (state/get-preferred-format)))
          title (string/capitalize (:block/name page-block))
          whiteboard-page? (model/whiteboard-page? page-block)
          format (if whiteboard-page? "edn" format)
          journal-page? (date/valid-journal-title? title)
          journal-title (date/normalize-journal-title title)
          journal-page? (and journal-page? (not (string/blank? journal-title)))
          filename (if journal-page?
                     (date/date->file-name journal-title)
                     (-> (or (:block/original-name page-block) (:block/name page-block))
                         (fs-util/file-name-sanity)))
          sub-dir (cond
                    journal-page?    (config/get-journals-directory)
                    whiteboard-page? (config/get-whiteboards-directory)
                    :else            (config/get-pages-directory))
          ext (if (= format "markdown") "md" format)
          file-rpath (if (and (s01/enabled?) (s01/document? (:block/original-name page-block)))
                       (:block/original-name page-block)
                       (path/path-join sub-dir (str filename "." ext)))
          file {:file/path file-rpath}
          tx [{:file/path file-rpath}
              {:block/name (:block/name page-block)
               :block/file file}]]
      (db/transact! tx)
      (when ok-handler (ok-handler)))))

(defn- remove-transit-ids [block] (dissoc block :db/id :block/file))

(defn save-tree-aux!
  [page-block tree blocks-just-deleted?]
  (let [page-block (db/pull (:db/id page-block))
        file-db-id (-> page-block :block/file :db/id)
        file-path (-> (db-utils/entity file-db-id) :file/path)]
    (if (and (string? file-path) (not-empty file-path))
      (let [new-content (if (= "whiteboard" (:block/type page-block))
                          (->
                           (up/ugly-pr-str {:blocks tree
                                            :pages (list (remove-transit-ids page-block))})
                           (string/triml))
                          (tree->file-content tree {:init-level init-level}))]
        (if (and (string/blank? new-content)
                 (not blocks-just-deleted?))
          (state/pub-event! [:capture-error {:error (js/Error. "Empty content")
                                             :payload {}}])
          (let [files [[file-path new-content]]
                repo (state/get-current-repo)]
            (file-handler/alter-files-handler!
             repo files
             (if (and (s01/enabled? repo) (s01/document? file-path))
               {:s01-state (s01-state/signature (db/get-db repo) (:db/id page-block))
                :s01-identity {:pageId (str (:block/uuid page-block))
                               :blockContents (->> (tree-seq #(seq (:block/children %)) :block/children {:block/children tree})
                                                   (filter :block/page) (mapv metadata/source-content))
                               :blockIds (->> (tree-seq #(seq (:block/children %)) :block/children
                                                       {:block/children tree})
                                              (filter :block/page) (mapv #(str (:block/uuid %))))}}
               {}) {}))))
      ;; In e2e tests, "card" page in db has no :file/path
      (js/console.error "File path from page-block is not valid" page-block tree))))

(defn save-tree!
  [page-block tree blocks-just-deleted?]
  {:pre [(map? page-block)]}
  (let [ok-handler #(save-tree-aux! page-block tree blocks-just-deleted?)
        file (or (:block/file page-block)
                 (when-let [page (:db/id (:block/page page-block))]
                   (:block/file (db-utils/entity page))))]
    (if file
      (ok-handler)
      (transact-file-tx-if-not-exists! page-block ok-handler))))

(defn buffer-dirty? [page-id]
  (let [editing (state/get-edit-block)
        current (when-let [id (:block/uuid editing)] (db/entity [:block/uuid id]))
        editing (or current editing)
        visible (some->> (:block/content editing)
                         (property/remove-built-in-properties (:block/format editing))
                         drawer/remove-logbook)]
    (and (= page-id (get-in editing [:block/page :db/id]))
         (some? (state/get-edit-content))
         (not= visible (state/get-edit-content)))))

(defn dirty? [repo page-name]
  (let [page-id (:db/id (db/entity repo [:block/name page-name]))]
    (or (buffer-dirty? page-id) (s01-state/dirty? repo (db/get-db repo) page-id))))

(defn editing-snapshot
  "Serialize current edits, preserving hidden properties when the buffer is unchanged."
  [repo page-name]
  (let [editing (state/get-edit-block)
        changed? (buffer-dirty? (get-in editing [:block/page :db/id]))
        blocks (model/get-page-blocks-no-cache repo page-name)
        blocks (map (fn [b] (if (and changed? (= (:block/uuid b) (:block/uuid editing)))
                             (assoc b :block/content
                               (property/with-built-in-properties (:block/properties b)
                                 (state/get-edit-content) (:block/format b))) b)) blocks)]
    (tree->file-content (tree/blocks->vec-tree repo blocks page-name) {:init-level init-level})))

(defn page-identity [repo page-name]
  (let [page (db/entity repo [:block/name page-name])
        blocks (model/get-page-blocks-no-cache repo page-name)
        tree (tree/blocks->vec-tree repo blocks page-name)]
    {:pageId (str (:block/uuid page))
     :blockIds (->> (tree-seq #(seq (:block/children %)) :block/children {:block/children tree})
                    (filter :block/page) (mapv #(str (:block/uuid %))))}))
