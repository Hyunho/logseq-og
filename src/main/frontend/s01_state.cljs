(ns frontend.s01-state
  "Tracks clean editor structures separately from the original Markdown bytes."
  (:require [datascript.core :as d]
            [frontend.s01-metadata :as metadata]))

(defonce baselines (atom {}))
(def editable-attrs #{:block/content :block/parent :block/left :block/properties
                      :block/pre-block? :block/format})

(defn signature [database page-id]
  (set (map (fn [id]
              (let [b (d/pull database '[*] id)]
                (assoc (select-keys b [:db/id :block/parent :block/left :block/pre-block? :block/format])
                       :block/content (metadata/source-content b)
                       :block/properties (metadata/source-properties b))))
            (d/q '[:find [?b ...] :in $ ?p :where [?b :block/page ?p]] database page-id))))

(defn saved! [repo page-id value]
  (swap! baselines assoc [repo page-id] value))

(defn dirty? [repo database page-id]
  (when-let [baseline (get @baselines [repo page-id])]
    (not= baseline (signature database page-id))))

(defn observe! [repo {:keys [db-before db-after tx-data tx-meta]}]
  (when-not (:s01/index-only? tx-meta)
    (let [entities (->> tx-data (filter #(contains? editable-attrs (:a %))) (map :e) set)
          pages (set (keep identity
                       (for [eid entities database [db-before db-after]]
                         (get-in (d/pull database '[:block/page] eid) [:block/page :db/id]))))]
      (doseq [page-id pages]
        (if (:from-disk? tx-meta)
          (saved! repo page-id (signature db-after page-id))
          (swap! baselines #(if (contains? % [repo page-id]) %
                               (assoc % [repo page-id] (signature db-before page-id)))))))))

(defn ui-only-transaction? [{:keys [tx-data]}]
  (and (some #(= :block/collapsed? (:a %)) tx-data)
       (every? #(contains? #{:block/collapsed? :block/updated-at :block/created-at} (:a %)) tx-data)))
