(ns frontend.s01-metadata
  "Provenance-aware projection: virtual app properties never replace authored Markdown."
  (:require [clojure.string :as string]
            [frontend.format.mldoc :as mldoc]
            [logseq.graph-parser.mldoc :as gp-mldoc]
            [logseq.graph-parser.utf8 :as utf8]
            [frontend.format.block :as gp-block]))

(defn- header [content]
  (let [lines (string/split-lines (or content ""))
        prop? #(boolean (and % (re-find #"^\s*[^\s:]+::(?:\s|$)" %)))
        fenced? (re-find #"^\s*(?:```|~~~)" (or (first lines) ""))
        [title tail] (if (prop? (first lines)) [[] lines] [(take 1 lines) (rest lines)])
        [props body] (if fenced? [[] tail] (split-with prop? tail))]
    [title props body]))

(defn- line-key [line]
  (some-> (re-find #"^\s*([^\s:]+)::" line) second string/lower-case keyword))

(defn property-lines [content k]
  (filterv #(= k (line-key %)) (second (header content))))

(defn- logbook-range [content]
  (some (fn [[ast pos]] (when (and (= "Drawer" (first ast)) (= "logbook" (second ast))) pos))
        (mldoc/->edn (or content "") (gp-mldoc/default-config :markdown))))

(defn logbook-value [content]
  (when-let [pos (logbook-range content)]
    (utf8/substring (utf8/encode content) (:start_pos pos) (:end_pos pos))))

(defn replace-logbook [content value]
  (if-let [pos (logbook-range content)]
    (let [encoded (utf8/encode content)
          before (utf8/substring encoded 0 (:start_pos pos))
          after (utf8/substring encoded (:end_pos pos))]
      (if (and (nil? value) (empty? after))
        (string/replace before #"\n$" "")
        (str before value after)))
    (if value
      (let [[title & body] (string/split-lines content)]
        (string/join "\n" (concat [title (string/trimr value)] body)))
      content)))

(defn source-content [block]
  (let [content (:block/content block)]
    (if-let [logbook (get-in block [:block/app-metadata :logbook])]
      (replace-logbook content (:source logbook))
      content)))

(defn source-properties [block]
  (not-empty (reduce-kv (fn [props k entry]
               (if (:source-present? entry) (assoc props k (:source-value entry)) (dissoc props k)))
             (:block/properties block) (or (get-in block [:block/app-metadata :properties]) {}))))

(defn set-properties [block kvs]
  (reduce (fn [b [k value]]
            (let [k (keyword k)
                  entry (or (get-in b [:block/app-metadata :properties k])
                            {:source-lines (property-lines (:block/content b) k)
                             :source-present? (contains? (:block/properties b) k)
                             :source-value (get-in b [:block/properties k])})]
              (-> b
                  (assoc-in [:block/app-metadata :properties k] (assoc entry :value value))
                  (update :block/properties #(if (nil? value) (dissoc % k) (assoc % k value)))
                  (update :block/properties-order (fn [ks] (vec (if (nil? value) (remove #{k} ks) (distinct (conj (vec ks) k))))))
                  (update :block/properties-text-values #(if (nil? value) (dissoc % k) (assoc % k value))))))
          block kvs))

(defn track-logbook [old-block block]
  (let [before (logbook-value (:block/content old-block))
        after (logbook-value (:block/content block))]
    (if (= before after) block
      (assoc-in block [:block/app-metadata :logbook]
                {:source (if-let [old (get-in old-block [:block/app-metadata :logbook])]
                           (:source old) before)
                 :value after}))))

(defn hydrate
  ([source metadata] (hydrate source metadata true))
  ([source metadata rebase?]
  (let [metadata (if rebase? (update metadata :properties
                         (fn [props] (into {} (map (fn [[k entry]]
                                                    [k (assoc entry
                                                              :source-lines (property-lines (:block/content source) k)
                                                              :source-present? (contains? (:block/properties source) k)
                                                              :source-value (get-in source [:block/properties k]))]) props)))) metadata)
        metadata (cond-> metadata (and rebase? (:logbook metadata))
                   (assoc-in [:logbook :source] (logbook-value (:block/content source))))
        block (reduce-kv (fn [b k entry]
                           (set-properties b [[k (:value entry)]]))
                         (assoc source :block/app-metadata metadata)
                         (or (:properties metadata) {}))
        block (if-let [logbook (:logbook metadata)]
                (assoc block :block/content
                       (replace-logbook (:block/content block) (:value logbook))) block)]
    (merge block (gp-block/parse-title-and-body (:block/uuid block) :markdown
                                               (:block/pre-block? block) (:block/content block))))))
