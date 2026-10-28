(ns frontend.s01-test
  (:require [cljs.test :refer [deftest is testing]]
            [frontend.s01 :as s01]
            [frontend.s01-metadata :as metadata]
            [frontend.external.roam :as roam]
            [frontend.modules.file.core :as file-core]
            [frontend.db.query-dsl :as query-dsl]
            [frontend.s01-state :as identity-state]
            [datascript.core :as d]
            [frontend.state :as state]
            [frontend.modules.editor.undo-redo :as undo-redo]
            [logseq.graph-parser.extract :as extract]
            [clojure.string :as string]))

(deftest filename-resolution-test
  (let [paths ["pages/업무/회의.md" "pages/개인/회의.md" "pages/unique.md"
               "pages/a.md" "pages/a.markdown" "logseq/conflicts/a.md"]]
    (is (= :ambiguous (:status (s01/resolve-document paths "회의"))))
    (is (= ["pages/업무/회의.md"] (:paths (s01/resolve-document paths "pages/업무/회의"))))
    (is (= ["pages/unique.md"] (:paths (s01/resolve-document paths "unique"))))
    (is (= :ambiguous (:status (s01/resolve-document paths "pages/a"))))
    (is (= ["pages/a.md"] (:paths (s01/resolve-document paths "pages/a.md"))))
    (is (= :missing (:status (s01/resolve-document paths "주간회의"))))
    (is (= :missing (:status (s01/resolve-document paths "logseq/conflicts/a.md"))))))

(deftest parser-identity-boundary-test
  (let [page-id (str (random-uuid))
        ids (atom [])
        options {:user-config {} :date-formatter "MMM do, yyyy" :filename-format :triple-lowbar
                 :document-name-fn identity
                 :identity-fn (fn [n]
                                (when (empty? @ids) (reset! ids (vec (repeatedly n #(str (random-uuid))))))
                                {:page-id page-id :block-ids @ids})}
        content "title:: 표시 제목\n\n- A\n  - B\n- ((12345678-1234-1234-1234-123456789abc))"
        a (extract/extract "pages/실제 이름.md" content options)
        b (extract/extract "pages/실제 이름.md" content options)]
    (is (= "pages/실제 이름.md" (:block/name (first (:pages a)))))
    (is (= page-id (str (:block/uuid (first (:pages a))))))
    (is (= (map (comp str :block/uuid) (:blocks a)) (map (comp str :block/uuid) (:blocks b)) @ids))
    (is (not-any? #(and (vector? %) (= :block/uuid (first %))) (mapcat :block/refs (:blocks a))))
    (is (some #(string/includes? (:block/content %) "((12345678") (:blocks a)))))

(deftest external-change-invalidates-only-related-history
  (with-redefs [state/get-current-repo (constantly "s01-undo-test")]
    (let [{:keys [undo-stack redo-stack]} (undo-redo/get-state)
          affected {:blocks [{:db/id 10 :block/page {:db/id 1}}]}
          other {:blocks [{:db/id 20 :block/page {:db/id 2}}]}
          mixed {:blocks [{:db/id 11 :block/page {:db/id 1}} {:db/id 21 :block/page {:db/id 2}}]}]
      (reset! undo-stack [other affected mixed])
      (reset! redo-stack [affected other])
      (undo-redo/invalidate-page! "s01-undo-test" 1)
      (is (= [other] @undo-stack))
      (is (= [other] @redo-stack)))))

(deftest empty-document-still-has-cached-page-identity
  (let [id (str (random-uuid))
        result (extract/extract "pages/empty.md" ""
                 {:user-config {} :date-formatter "MMM do, yyyy"
                  :document-name-fn identity
                  :identity-fn (fn [n] (is (zero? n)) {:page-id id :block-ids []})})]
    (is (= id (str (:block/uuid (first (:pages result))))))
    (is (empty? (:blocks result)))))

(deftest logical-tag-references-are-not-discarded
  (with-redefs [s01/lookup-document (constantly {:status :missing})]
    (is (= {:block/name "tag"} (s01/document-ref {:block/name "tag"})))
    (is (nil? (s01/document-ref [:block/uuid (random-uuid)])))))

(deftest preferred-link-spelling
  (is (= "회의" (s01/preferred-link ["pages/회의.md"] "pages/회의.md")))
  (is (= "pages/회의" (s01/preferred-link ["pages/회의.md" "notes/회의.md"] "pages/회의.md")))
  (is (= "pages/회의.md" (s01/preferred-link ["pages/회의.md" "pages/회의.markdown"] "pages/회의.md")))
  (is (= "pages/회의" (s01/preferred-link ["pages/회의.md" "notes/회의.markdown"] "pages/회의.md"))))

(deftest canonical-filenames-remain-distinct
  (is (not= (s01/document-key "pages/A.md") (s01/document-key "pages/a.md")))
  (is (not= (s01/document-key "pages/é.md") (s01/document-key "pages/é.md")))
  (is (= ["pages/é.md"] (:paths (s01/resolve-document ["pages/é.md"] "é"))))
  (is (= :ambiguous (:status (s01/resolve-document ["pages/é.md" "pages/é.md"] "é"))))
  (is (= ["pages/A.md"] (:paths (s01/resolve-document ["pages/A.md" "pages/a.md"] "A")))))

(deftest actual-edit-baseline-test
  (let [repo "s01-baseline-test"
        conn (d/create-conn {:block/page {:db/valueType :db.type/ref}
                             :block/parent {:db/valueType :db.type/ref}})]
    (swap! identity-state/baselines #(into {} (remove (fn [[[r _] _]] (= r repo)) %)))
    (d/listen! conn ::baseline #(identity-state/observe! repo %))
    (d/transact! conn [{:db/id 1 :block/name "pages/plain.md"}
                       {:db/id 2 :block/page 1 :block/parent 1 :block/content "paragraph"}]
                 {:from-disk? true})
    (is (false? (identity-state/dirty? repo @conn 1)))
    (let [saved (identity-state/signature @conn 1)]
      (d/transact! conn [{:db/id 2 :block/content "edited"}])
      (is (true? (identity-state/dirty? repo @conn 1)))
      (identity-state/saved! repo 1 saved)
      (is (true? (identity-state/dirty? repo @conn 1)))
      (d/transact! conn [{:db/id 2 :block/content "paragraph"}])
      (is (false? (identity-state/dirty? repo @conn 1))))
    (d/transact! conn [{:db/id 3 :block/page 1 :block/parent 2 :block/content "child"}])
    (is (true? (identity-state/dirty? repo @conn 1)))
    (d/transact! conn [{:db/id 2 :block/content "external"}] {:from-disk? true})
    (is (false? (identity-state/dirty? repo @conn 1)))
    (d/transact! conn [{:db/id 2 :block/refs 99}] {:s01/index-only? true})
    (is (false? (identity-state/dirty? repo @conn 1)))))

(deftest document-query-targets-use-physical-identity
  (with-redefs [s01/enabled? (constantly true)
                s01/lookup-document (fn [target] (when (= target "A") {:page-name "s01/file/0041"}))]
    (is (string/includes? (pr-str (:query (query-dsl/parse "[[A]]"))) "s01/file/0041"))
    (is (string/includes? (pr-str (:query (query-dsl/parse "(page [[A]])"))) "s01/file/0041"))
    (is (string/includes? (pr-str (:query (query-dsl/parse "[[card]]"))) "card"))))

(deftest collapsed-is-not-a-document-edit
  (let [conn (d/create-conn {:block/page {:db/valueType :db.type/ref}})
        _ (d/transact! conn [{:db/id 1 :block/name "test"}
                             {:db/id 2 :block/page 1 :block/content "parent"}])
        baseline (identity-state/signature @conn 1)
        tx (d/transact! conn [{:db/id 2 :block/collapsed? true :block/updated-at 10}])]
    (is (identity-state/ui-only-transaction? tx))
    (is (= baseline (identity-state/signature @conn 1)))
    (is (not (identity-state/ui-only-transaction?
               (d/transact! conn [{:db/id 2 :block/collapsed? false :block/content "edited"}]))))))

(deftest collapsed-serialization-boundary
  (with-redefs [s01/enabled? (constantly true)]
    (is (= "- parent" (file-core/transform-content
                        {:block/content "parent" :block/format :markdown :block/collapsed? true} 1 {}))))
  (is (= "parent\nowner:: me\nbody" (file-core/without-collapsed-property "parent\ncollapsed:: true\nowner:: me\nbody")))
  (doseq [content ["```\ncollapsed:: true\n```" "parent\n\n```\ncollapsed:: true\n```"]]
    (is (= content (file-core/without-collapsed-property content)))))

(deftest collapsed-restored-from-side-store
  (let [page-id (str (random-uuid)) block-id (str (random-uuid))]
    (doseq [collapsed [true false]]
      (let [result (extract/extract "pages/a.md" "- parent\n  collapsed:: true"
                     {:user-config {} :date-formatter "MMM do, yyyy"
                      :document-name-fn identity
                      :identity-fn (fn [_] {:page-id page-id :block-ids [block-id]
                                           :collapsed {block-id collapsed}})})]
        (is (= collapsed (:block/collapsed? (first (:blocks result)))))))))

(deftest feature-metadata-keeps-authored-properties
  (let [source {:block/content "question\nquery-sort-by:: authored\nowner:: me"
                :block/format :markdown :block/uuid (random-uuid)
                :block/properties {:query-sort-by "authored" :owner "me"}}
        changed (metadata/set-properties source [[:query-sort-by "updated-at"] [:card-repeats 3] [:background-color "red"]])
        restored (metadata/hydrate source (:block/app-metadata changed))]
    (is (= (:block/content source) (metadata/source-content changed)))
    (is (= (:block/properties source) (metadata/source-properties changed)))
    (is (= "updated-at" (get-in restored [:block/properties :query-sort-by])))
    (is (= 3 (get-in restored [:block/properties :card-repeats])))
    (is (= (:block/content source) (metadata/source-content restored)))
    (let [edited (assoc source :block/content "question\nquery-sort-by:: manual-new\nowner:: me"
                              :block/properties {:query-sort-by "manual-new" :owner "me"})
          restored (metadata/hydrate edited (:block/app-metadata changed))]
      (is (= (:block/content edited) (metadata/source-content restored))))))

(deftest app-logbook-does-not-leak-or-remove-authored-drawer
  (doseq [original ["TODO task" "TODO task\n:LOGBOOK:\nmanual history\n:END:"]]
    (let [old {:block/content original :block/format :markdown :block/uuid (random-uuid)}
          generated {:block/content "DOING task\n:LOGBOOK:\nCLOCK: [2026-10-28 Wed 10:00]\n:END:" :block/format :markdown}
          tracked (metadata/track-logbook old generated)]
      (is (= (string/replace original "TODO" "DOING") (metadata/source-content tracked))))))

(deftest roam-import-detaches-generated-ids-only
  (let [data [{:title "Imported" :children [{:uid "abc123456" :string "target"}
                                           {:uid "def123456" :string "((abc123456))"}]}]
        legacy (doall (roam/->files data))
        detached (binding [roam/*s01-import?* true] (doall (roam/->files data)))]
    (is (string/includes? (:text (first legacy)) "id::"))
    (is (not (string/includes? (:text (first detached)) "id::")))
    (is (some :id (:app-properties (first detached))))))
