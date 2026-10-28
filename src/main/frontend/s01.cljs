(ns frontend.s01
  "S01 graph policy and the Electron-owned identity/recovery store."
  (:require [cljs-bean.core :as bean]
            [datascript.core :as d]
            [cljs.reader :as reader]
            [clojure.string :as string]
            [frontend.config :as config]
            [frontend.db.model :as db]
            [frontend.state :as state]
            [frontend.util :as util]
            [logseq.graph-parser.block :as gp-block]))

(defn enabled?
  ([] (enabled? (state/get-current-repo)))
  ([repo] (and (util/electron?) (true? (:s01/enabled? (state/get-config repo))))))

(defn document? [path]
  (and (string? path) (re-find #"(?i)\.(md|markdown)$" path)
       (not (re-find #"^(logseq|assets)/" path))))

(defn call! [repo op args]
  (let [result (bean/->clj (js/window.apis.s01
                           (bean/->js (merge {:op op :root (config/get-repo-dir repo)} args))))]
    (when-let [error (:error result)] (throw (js/Error. error)))
    (when-let [notice (:notice (:value result))]
      (state/pub-event! [:notification/show {:content notice :status :warning}]))
    (:value result)))

(defn document-key
  "Keep ordinary paths readable, but encode paths which DataScript's lowercase names would alias."
  [file]
  (cond
    (re-find #"^journals/[0-9_\-]+\.md$" file)
    (second (gp-block/convert-page-if-journal
              (-> file (string/split #"/") last (string/replace #"\.md$" "")
                  (string/replace "_" "-")) (state/get-date-formatter)))
    (and (= file (string/lower-case file)) (= file (.normalize file "NFC"))
         (not (string/starts-with? file "s01/file/"))) file
    :else (str "s01/file/" (apply str (map #(-> (.charCodeAt % 0) (.toString 16) (.padStart 4 "0")) (seq file))))))

(defn resolve-document
  "Resolve only by file name/path. Returns all candidates; never picks an ambiguous target."
  [paths target]
  (let [target (.normalize (string/replace (string/trim target) #"^\./" "") "NFC")
        qualified? (string/includes? target "/")
        extension? (boolean (re-find #"(?i)\.(md|markdown)$" target))
        key-fn (fn [p] (let [p (if qualified? p (last (string/split p #"/")))]
                         (if extension? p (string/replace p #"(?i)\.(md|markdown)$" ""))))
        candidates (->> paths (filter document?) (filter #(= target (.normalize (key-fn %) "NFC"))) sort vec)]
    {:status (case (count candidates) 0 :missing 1 :found :ambiguous)
     :paths candidates}))

(defn lookup-document [target]
  (let [paths (map first (db/get-files (state/get-current-repo)))
        result (resolve-document paths target)]
    (assoc result :page-name (when (= :found (:status result))
                               (db/get-file-page (first (:paths result)))))))

(defn document-ref
  "Resolve file-backed page references while retaining logical tag/property entities."
  [ref]
  (when-let [target (and (map? ref) (or (:block/original-name ref) (:block/name ref)))]
    (let [result (lookup-document target)]
      (if-let [page-name (:page-name result)]
        (assoc (dissoc ref :block/uuid :db/id) :block/name (util/page-name-sanity-lc page-name)
               :block/original-name (first (:paths result)))
        ref))))

(defn preferred-link [paths file]
  (let [qualified (string/replace file #"(?i)\.(md|markdown)$" "")
        short (last (string/split qualified #"/"))]
    (cond
      (= :found (:status (resolve-document paths short))) short
      (= :found (:status (resolve-document paths qualified))) qualified
      :else file)))

(defn preferred-target [page]
  (if-let [file (:file/path (db/get-page-file page))]
    (preferred-link (map first (db/get-files (state/get-current-repo))) file)
    page))

(defonce index-timers (atom {}))
(defn reconcile-index-later! [repo]
  (when-let [timer (get @index-timers repo)] (js/clearTimeout timer))
  (swap! index-timers assoc repo
         (js/setTimeout #(do (swap! index-timers dissoc repo)
                             (state/pub-event! [:s01/reconcile-index repo])) 200)))

(defn persist-block-ui!
  "Persist UI changes, including undo/redo and imported legacy collapsed states."
  [repo {:keys [db-after tx-data tx-meta]}]
  (when-not (:s01/index-only? tx-meta)
    (let [ids (set (map :e (filter #(= :block/collapsed? (:a %)) tx-data)))
          entries (keep (fn [eid]
                          (let [b (d/entity db-after eid)
                                file (get-in b [:block/page :block/file :file/path])]
                            (when (and (:block/uuid b) (document? file))
                              {:id (str (:block/uuid b)) :collapsed (boolean (:block/collapsed? b))}))) ids)]
      (when (seq entries)
        (try (call! repo "save-block-ui" {:entries (vec entries)})
             (catch :default e
               (state/pub-event! [:notification/show
                                 {:content (str "접힘 상태를 저장하지 못했습니다: " (.-message e)) :status :error}])))))))

(defn metadata-map [repo]
  (into {} (map (fn [{:keys [id data]}] [id (reader/read-string data)]))
        (call! repo "block-metadata" {})))

(defonce pending-metadata (atom {}))

(defn persist-metadata! [repo {:keys [db-after tx-data tx-meta]}]
  (when-not (or (:s01/index-only? tx-meta) (:from-disk? tx-meta))
    (let [ids (set (map :e (filter #(= :block/app-metadata (:a %)) tx-data)))
          entries (keep (fn [eid]
                          (let [b (d/entity db-after eid)]
                            (when (:block/uuid b)
                              {:id (str (:block/uuid b)) :data (pr-str (or (:block/app-metadata b) {}))}))) ids)]
      (swap! pending-metadata update repo merge (into {} (map (juxt :id identity) entries)))
      (when-let [pending (seq (vals (get @pending-metadata repo)))]
        (try
          (call! repo "save-block-metadata" {:entries (vec pending)})
          (swap! pending-metadata dissoc repo)
          (catch :default e
            (state/pub-event! [:notification/show
                              {:content (str "앱 메타데이터를 저장하지 못했습니다. 다음 편집 시 재시도합니다: " (.-message e))
                               :status :error}])
            (throw e)))))))
