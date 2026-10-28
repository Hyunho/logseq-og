(ns frontend.handler.events
  "System-component-like ns that defines named events and listens on a
  core.async channel to handle them. Any part of the system can dispatch
  one of these events using state/pub-event!"
  (:refer-clojure :exclude [run!])
  (:require [datascript.core :as d]
            ["@capacitor/filesystem" :refer [Directory Filesystem]]
            ["@sentry/react" :as Sentry]
            [electron.ipc :as ipc]
            [frontend.idb :as idb]
            [cljs-bean.core :as bean]
            [clojure.core.async :as async]
            [clojure.core.async.interop :refer [p->c]]
            [clojure.set :as set]
            [clojure.string :as string]
            [frontend.commands :as commands]
            [frontend.components.cmdk :as cmdk]
            [frontend.components.conversion :as conversion-component]
            [frontend.components.settings :as settings]
            [frontend.components.diff :as diff]
            [frontend.components.encryption :as encryption]
            [frontend.components.file-sync :as file-sync]
            [frontend.components.git :as git-component]
            [frontend.components.plugins :as plugin]
            [frontend.components.shell :as shell]
            [frontend.components.whiteboard :as whiteboard]
            [frontend.components.user.login :as login]
            [frontend.config :as config]
            [frontend.s01 :as s01]
            [frontend.s01-metadata :as metadata]
            [frontend.modules.editor.undo-redo :as undo-redo]
            [frontend.modules.file.core :as file-core]
            [frontend.context.i18n :refer [t]]
            [frontend.db :as db]
            [frontend.db.conn :as conn]
            [frontend.db.react :as db-react]
            [frontend.db.model :as db-model]
            [frontend.db.persist :as db-persist]
            [frontend.extensions.srs :as srs]
            [frontend.fs :as fs]
            [frontend.fs.capacitor-fs :as capacitor-fs]
            [frontend.fs.nfs :as nfs]
            [frontend.fs.sync :as sync]
            [frontend.fs.watcher-handler :as fs-watcher]
            [frontend.handler.common :as common-handler]
            [frontend.handler.editor :as editor-handler]
            [frontend.handler.file :as file-handler]
            [frontend.handler.file-sync :as file-sync-handler]
            [frontend.handler.notification :as notification]
            [frontend.handler.page :as page-handler]
            [frontend.handler.plugin :as plugin-handler]
            [frontend.handler.repo :as repo-handler]
            [frontend.handler.repo-config :as repo-config-handler]
            [frontend.handler.route :as route-handler]
            [frontend.handler.search :as search-handler]
            [frontend.handler.shell :as shell-handler]
            [frontend.handler.ui :as ui-handler]
            [frontend.handler.user :as user-handler]
            [frontend.handler.whiteboard :as whiteboard-handler]
            [frontend.handler.web.nfs :as nfs-handler]
            [frontend.mobile.core :as mobile]
            [frontend.mobile.graph-picker :as graph-picker]
            [frontend.mobile.util :as mobile-util]
            [frontend.modules.instrumentation.posthog :as posthog]
            [frontend.modules.instrumentation.sentry :as sentry-event]
            [frontend.modules.outliner.file :as outliner-file]
            [frontend.modules.shortcut.core :as st]
            [frontend.quick-capture :as quick-capture]
            [frontend.search :as search]
            [frontend.state :as state]
            [frontend.ui :as ui]
            [frontend.util :as util]
            [frontend.util.persist-var :as persist-var]
            [goog.dom :as gdom]
            [logseq.db.schema :as db-schema]
            [logseq.graph-parser.config :as gp-config]
            [promesa.core :as p]
            [rum.core :as rum]))

;; TODO: should we move all events here?

(defmulti handle first)

(defn- file-sync-restart! []
  (async/go (async/<! (p->c (persist-var/load-vars)))
            (async/<! (sync/<sync-stop))
            (some-> (sync/<sync-start) async/<!)))

(defn- file-sync-stop! []
  (async/go (async/<! (p->c (persist-var/load-vars)))
            (async/<! (sync/<sync-stop))))

(defn- enable-beta-features!
  []
  (when-not (false? (state/enable-sync?)) ; user turns it off
    (file-sync-handler/set-sync-enabled! true)))

(defmethod handle :user/fetch-info-and-graphs [[_]]
  (state/set-state! [:ui/loading? :login] false)
  (async/go
    (let [result (async/<! (sync/<user-info sync/remoteapi))]
      (cond
        (instance? ExceptionInfo result)
        nil
        (map? result)
        (do
          (state/set-user-info! result)
          (when-let [uid (user-handler/user-uuid)]
            (sentry-event/set-user! uid))
          (let [status (if (user-handler/alpha-or-beta-user?) :welcome :unavailable)]
            (when (and (= status :welcome) (user-handler/logged-in?))
              (enable-beta-features!)
              (async/<! (file-sync-handler/load-session-graphs))
              (p/let [repos (repo-handler/refresh-repos!)]
                (when-let [repo (state/get-current-repo)]
                  (when (some #(and (= (:url %) repo)
                                    (vector? (:sync-meta %))
                                    (util/uuid-string? (first (:sync-meta %)))
                                    (util/uuid-string? (second (:sync-meta %)))) repos)
                    (sync/<sync-start)))))
            (ui-handler/re-render-root!)
            (file-sync/maybe-onboarding-show status)))))))

(defmethod handle :user/logout [[_]]
  (file-sync-handler/reset-session-graphs)
  (sync/remove-all-pwd!)
  (file-sync-handler/reset-user-state!)
  (login/sign-out!))

(defmethod handle :user/login [[_ host-ui?]]
  (if (or host-ui? (not util/electron?))
    (js/window.open config/LOGIN-URL)
    (if (mobile-util/native-platform?)
      (route-handler/redirect! {:to :user-login})
      (login/open-login-modal!))))

(defmethod handle :graph/added [[_ repo {:keys [empty-graph?]}]]
  (state/pub-event! [:s01/ready repo])
  (db/set-key-value repo :ast/version db-schema/ast-version)
  (search-handler/rebuild-indices!)
  (db/persist! repo)
  (plugin-handler/hook-plugin-app :graph-after-indexed {:repo repo :empty-graph? empty-graph?})
  (when (state/setups-picker?)
    (if empty-graph?
      (route-handler/redirect! {:to :import :query-params {:from "picker"}})
      (route-handler/redirect-to-home!)))
  (when-let [dir-name (config/get-repo-dir repo)]
    (fs/watch-dir! dir-name))
  (file-sync-restart!))

(defmethod handle :graph/unlinked [repo current-repo]
  (when (= (:url repo) current-repo)
    (file-sync-restart!)))

;; FIXME(andelf): awful multi-arty function.
;; Should use a `-impl` function instead of the awful `skip-ios-check?` param with nested callback.
(defn- graph-switch
  ([graph]
   (graph-switch graph false))
  ([graph skip-ios-check?]
   (if (and (mobile-util/native-ios?) (not skip-ios-check?))
     (state/pub-event! [:validate-appId graph-switch graph])
     (do
       (state/set-current-repo! graph)
       ;; load config
       (repo-config-handler/restore-repo-config! graph)
       (when-not (= :draw (state/get-current-route))
         (route-handler/redirect-to-home!))
       (srs/update-cards-due-count!)
       (state/pub-event! [:graph/ready graph])
       (file-sync-restart!)
       (when-let [dir-name (config/get-repo-dir graph)]
         (fs/watch-dir! dir-name))))))

;; Parameters for the `persist-db` function, to show the notification messages
(def persist-db-noti-m
  {:before     #(ui/notify-graph-persist!)
   :on-error   #(ui/notify-graph-persist-error!)})

(defn- graph-switch-on-persisted
  "Logic for keeping db sync when switching graphs
   Only works for electron
   graph: the target graph to switch to"
  [graph {:keys [persist?]}]
  (let [current-repo (state/get-current-repo)]
    (p/do!
     (when persist?
       (when (util/electron?)
         (p/do!
          (repo-handler/persist-db! current-repo persist-db-noti-m)
          (repo-handler/broadcast-persist-db! graph))))
     (repo-handler/restore-and-setup-repo! graph)
     (graph-switch graph)
     (state/set-state! :sync-graph/init? false))))

(defmethod handle :graph/switch [[_ graph opts]]
  (let [opts (if (false? (:persist? opts)) opts (assoc opts :persist? true))]
    (if (or (not (false? (get @outliner-file/*writes-finished? graph)))
            (:sync-graph/init? @state/state))
      (graph-switch-on-persisted graph opts)
      (notification/show!
       "Please wait seconds until all changes are saved for the current graph."
       :warning))))

(defmethod handle :graph/pull-down-remote-graph [[_ graph dir-name]]
  (if (mobile-util/native-ios?)
    (when-let [graph-name (or dir-name (:GraphName graph))]
      (let [graph-name (util/safe-sanitize-file-name graph-name)]
        (if (string/blank? graph-name)
          (notification/show! "Illegal graph folder name.")

          ;; Create graph directory under Logseq document folder (local)
          (when-let [root (state/get-local-container-root-url)]
            (let [graph-path (graph-picker/validate-graph-dirname root graph-name)]
              (->
               (p/let [exists? (fs/dir-exists? graph-path)]
                 (let [overwrite? (if exists?
                                    (js/confirm (str "There's already a directory with the name \"" graph-name "\", do you want to overwrite it? Make sure to backup it first if you're not sure about it."))
                                    true)]
                   (if overwrite?
                     (p/let [_ (fs/mkdir-if-not-exists graph-path)]
                       (nfs-handler/ls-dir-files-with-path!
                        graph-path
                        {:ok-handler (fn []
                                       (file-sync-handler/init-remote-graph graph-path graph)
                                       (js/setTimeout (fn [] (repo-handler/refresh-repos!)) 200))}))
                     (let [graph-name (-> (js/prompt "Please specify a new directory name to download the graph:")
                                          str
                                          string/trim)]
                       (when-not (string/blank? graph-name)
                         (state/pub-event! [:graph/pull-down-remote-graph graph graph-name]))))))
               (p/catch (fn [^js e]
                          (notification/show! (str e) :error)
                          (js/console.error e)))))))))
    (state/set-modal!
     (file-sync/pick-dest-to-sync-panel graph)
     {:center? true})))

(defmethod handle :graph/pick-page-histories [[_ graph-uuid page-name]]
  (state/set-modal!
   (file-sync/pick-page-histories-panel graph-uuid page-name)
   {:id :page-histories :label "modal-page-histories"}))

(defmethod handle :graph/open-new-window [[_ev repo]]
  (p/let [current-repo (state/get-current-repo)
          target-repo (or repo current-repo)
          _ (repo-handler/persist-db! current-repo persist-db-noti-m) ;; FIXME: redundant when opening non-current-graph window
          _ (when-not (= current-repo target-repo)
              (repo-handler/broadcast-persist-db! repo))]
    (ui-handler/open-new-window! repo)))

(defmethod handle :graph/migrated [[_ _repo]]
  (js/alert "Graph migrated."))

(defmethod handle :graph/save [_]
  (repo-handler/persist-db! (state/get-current-repo)
                            {:before     #(notification/show!
                                           (ui/loading (t :graph/save))
                                           :warning)
                             :on-success #(do
                                            (notification/clear-all!)
                                            (notification/show!
                                             (t :graph/save-success)
                                             :success))
                             :on-error   #(notification/show!
                                           (t :graph/save-error)
                                           :error)}))

(defn get-local-repo
  []
  (when-let [repo (state/get-current-repo)]
    (when (config/local-db? repo)
      repo)))

(defn ask-permission
  [repo]
  (when
   (and (not (util/electron?))
        (not (mobile-util/native-platform?)))
    (fn [close-fn]
      [:div
      ;; TODO: fn translation with args
       [:p
        "Grant native filesystem permission for directory: "
        [:b (config/get-local-dir repo)]]
       (ui/button
        (t :settings-permission/start-granting)
        :class "ui__modal-enter"
        :on-click (fn []
                    (nfs/check-directory-permission! repo)
                    (close-fn)))])))

(defmethod handle :modal/nfs-ask-permission []
  (when-let [repo (get-local-repo)]
    (state/set-modal! (ask-permission repo))))

(defonce *query-properties (atom {}))
(rum/defc query-properties-settings-inner < rum/reactive
  {:will-unmount (fn [state]
                   (reset! *query-properties {})
                   state)}
  [block shown-properties all-properties _close-fn]
  (let [query-properties (rum/react *query-properties)]
    [:div.p-4
     [:div.font-bold (t :query/config-property-settings)]
     (for [property all-properties]
       (let [property-value (get query-properties property)
             shown? (if (nil? property-value)
                      (contains? shown-properties property)
                      property-value)]
         [:div.flex.flex-row.m-2.justify-between.align-items
          [:div (name property)]
          [:div.mt-1 (ui/toggle shown?
                                (fn []
                                  (let [value (not shown?)]
                                    (swap! *query-properties assoc property value)
                                    (editor-handler/set-block-query-properties!
                                     (:block/uuid block)
                                     all-properties
                                     property
                                     value)))
                                true)]]))]))

(defn query-properties-settings
  [block shown-properties all-properties]
  (fn [close-fn]
    (query-properties-settings-inner block shown-properties all-properties close-fn)))

(defmethod handle :modal/set-query-properties [[_ block all-properties]]
  (let [block-properties (some-> (get-in block [:block/properties :query-properties])
                                 (common-handler/safe-read-string "Parsing query properties failed"))
        shown-properties (if (seq block-properties)
                           (set block-properties)
                           (set all-properties))
        shown-properties (set/intersection (set all-properties) shown-properties)]
    (state/set-modal! (query-properties-settings block shown-properties all-properties)
                      {:center? true})))

(defmethod handle :modal/show-cards [_]
  (state/set-modal! srs/global-cards {:id :srs
                                      :label "flashcards__cp"}))

(defmethod handle :modal/show-instruction [_]
  (state/set-modal! capacitor-fs/instruction {:id :instruction
                                              :label "instruction__cp"}))

(defmethod handle :modal/show-themes-modal [_]
  (plugin/open-select-theme!))

(defmethod handle :modal/toggle-accent-colors-modal [_]
  (let [label "accent-colors-picker"]
    (if (or (= label (state/get-modal-id))
            (= label (some-> (state/get-sub-modals) (first) :modal/id)))
      (state/close-sub-modal! label)
      (state/set-sub-modal!
       #(settings/modal-accent-colors-inner)
       {:center? true
        :id      label
        :label   label}))))

(rum/defc modal-output
  [content]
  content)

(defmethod handle :modal/show [[_ content]]
  (state/set-modal! #(modal-output content)))

(defmethod handle :modal/set-git-username-and-email [[_ _content]]
  (state/set-modal! git-component/set-git-username-and-email))

(defmethod handle :page/title-property-changed [[_ old-title new-title]]
  (when-not (s01/enabled?) (page-handler/rename! old-title new-title)))

(defmethod handle :page/create [[_ page-name opts]]
  (if (and (s01/enabled?) (not (:journal? opts)))
    (state/pub-event! [:s01/open-document page-name])
    (page-handler/create! page-name opts)))

(defmethod handle :page/create-today-journal [[_ _repo]]
  (p/let [_ (page-handler/create-today-journal!)]
    (ui-handler/re-render-root!)))

(defmethod handle :s01/link-plan [[_ repo id]]
  (let [plan (s01/call! repo "plan" {:id id})
        plan (update plan :updates #(remove (fn [u] (contains? (set (:applied plan)) (:path u))) %))
        selected (atom (set (map :path (:updates plan))))]
    (state/set-modal!
     (fn [] [:div.p-4 [:h2 "문서 링크·임베드 수정안"]
             [:p "파일별 변경 내용을 확인하고 반영할 문서를 선택해 주세요."]
             (for [update (:updates plan)]
               [:div.my-4 {:key (:path update)}
                [:label [:input {:type "checkbox" :default-checked true
                                 :on-change #(swap! selected (if (.. % -target -checked) conj disj) (:path update))}]
                 (:path update)]
                [:pre.whitespace-pre-wrap (:before update)]
                [:p "→"] [:pre.whitespace-pre-wrap (:after update)]])
             (ui/button "선택한 문서 수정" :on-click
               (fn []
                 (try
                   (let [safe (filterv
                               (fn [path]
                                 (let [page (db/get-file-page path)]
                                   (or (nil? page)
                                       (not (file-core/dirty? repo page)))))
                               @selected)
                         results (s01/call! repo "apply-plan" {:id id :selected safe})]
                     (state/close-modal!)
                     (doseq [result results]
                       (when (= "conflict" (:status result))
                         (state/pub-event! [:s01/conflict repo (:id (:conflict result))])))
                     (when (or (not= (count safe) (count @selected))
                               (some #(= "changed" (:status %)) results))
                       (notification/show! "편집 중이거나 변경된 문서는 수정하지 않았습니다. 다시 확인해 주세요." :warning)))
                   (catch :default e (notification/show! (str e) :error)))))])
     {:label "s01-link-plan"})))

(defmethod handle :s01/move-document [[_ relative]]
  (let [repo (state/get-current-repo)
        destination (atom relative)]
    (state/set-modal!
     (fn [] [:div.p-4 [:h2 "파일 이름·위치 변경"]
             [:input.w-full {:default-value relative :on-change #(reset! destination (util/evalue %))}]
             (ui/button "이동하고 링크 수정안 확인" :on-click
               (fn []
                 (try
                   (let [page (db/get-file-page relative)
                         expected (db/get-file repo relative)]
                     (when (file-core/dirty? repo page)
                       (throw (js/Error. "미저장 편집을 먼저 저장하거나 충돌을 해결해 주세요.")))
                     (let [result (s01/call! repo "move" {:relative relative :destination @destination :expected expected})]
                       (state/close-modal!)
                       (when-let [plan (:plan result)]
                         (state/pub-event! [:s01/link-plan repo (:id plan)]))))
                   (catch :default e (notification/show! (str e) :error)))))])
     {:label "s01-move-document"})))

(defmethod handle :s01/open-document [[_ target]]
  (let [repo (state/get-current-repo)
        resolution (s01/lookup-document target)]
    (case (:status resolution)
      :found (route-handler/redirect-to-page! (:page-name resolution))
      :ambiguous
      (state/set-modal!
       (fn [] [:div.p-4 [:h2 "동명 문서: 경로를 사용해 구분해 주세요."]
               (for [path (:paths resolution)]
                 [:div {:key path} (ui/button path :on-click
                   #(do (state/close-modal!)
                        (route-handler/redirect-to-page! (db/get-file-page path))))])])
       {:label "s01-document-candidates"})
      :missing
      (let [relative (atom (str (when-not (string/includes? target "/") "pages/") target
                                (when-not (re-find #"(?i)\.(md|markdown)$" target) ".md")))]
        (state/set-modal!
         (fn [] [:div.p-4 [:h2 "문서 생성 위치"]
                 [:input.w-full {:default-value @relative :on-change #(reset! relative (util/evalue %))}]
                 (ui/button "생성" :on-click
                   (fn []
                     (try
                       (let [result (s01/call! repo "save" {:relative @relative :expected nil :content "- "})]
                         (if (= "saved" (:status result))
                           (do (file-handler/alter-file repo @relative "- " {:from-disk? true :re-render-root? true})
                               (state/close-modal!)
                               (route-handler/redirect-to-page! (db/get-file-page @relative)))
                           (notification/show! "이미 존재하거나 충돌 중인 파일입니다. 다른 위치를 선택해 주세요." :warning)))
                       (catch :default e (notification/show! (str e) :error)))))] )
         {:label "s01-create-document"})))))

(defmethod handle :s01/reconcile-index [[_ repo]]
  (when (and (= repo (state/get-current-repo)) (s01/enabled? repo))
    (let [tx (mapcat
               (fn [[file _]]
                 (when (s01/document? file)
                   (mapcat (fn [block]
                             (let [parsed (editor-handler/wrap-parse-block block)
                                   refs (mapv #(dissoc % :block/uuid :db/id) (:block/refs parsed))]
                               [[:db/retract (:db/id block) :block/refs]
                                {:db/id (:db/id block) :block/refs refs}]))
                     (db/get-page-blocks-no-cache repo (db/get-file-page file)))))
               (db/get-files repo))]
      (when (seq tx)
        (db/transact! repo tx {:s01/index-only? true})
        (let [database (db/get-db repo)
              paths-tx (mapcat
                         (fn [[file _]]
                           (when (s01/document? file)
                             (mapcat (fn [block]
                                       (let [refs (loop [id (:db/id block) seen #{} refs #{(get-in block [:block/page :db/id])}]
                                                    (if (or (nil? id) (seen id))
                                                      (disj refs nil)
                                                      (let [entity (d/entity database id)]
                                                        (recur (get-in entity [:block/parent :db/id]) (conj seen id)
                                                               (into refs (map :db/id (:block/refs entity)))))))]
                                         [[:db/retract (:db/id block) :block/path-refs]
                                          {:db/id (:db/id block) :block/path-refs refs}]))
                               (db/get-page-blocks-no-cache repo (db/get-file-page file)))))
                         (db/get-files repo))]
          (when (seq paths-tx) (db/transact! repo paths-tx {:s01/index-only? true})))))))

(defmethod handle :s01/reconcile-cache [[_ repo paths]]
  (when (and (= repo (state/get-current-repo)) (s01/enabled? repo))
    (let [pending (set (map :path (s01/call! repo "conflicts" {})))]
      (doseq [[file _] (db/get-files repo)
              :let [page (db/get-file-page file)]
              :when (and (s01/document? file) (or (nil? paths) ((set paths) file))
                         (not (pending file)) (not (file-core/dirty? repo page)))]
        (let [content (:content (s01/call! repo "read" {:relative file}))]
          (when (some? content)
            (undo-redo/invalidate-page! repo (db/get-file-page-id file))
            (when (= (db/get-file-page-id file) (get-in (state/get-edit-block) [:block/page :db/id]))
              (state/clear-edit!))
            (file-handler/alter-file repo file content {:from-disk? true :re-render-root? true})))))))

(defonce s01-health-timer (atom nil))
(defonce s01-cache-generations (atom {}))
(defn- start-s01-health! [repo]
  (let [health (s01/call! repo "health" {})
        previous (get @s01-cache-generations repo)]
    (when (or (:reset health) (and previous (not= previous (:generation health))))
      (state/pub-event! [:s01/reconcile-cache repo]))
    (swap! s01-cache-generations assoc repo (:generation health)))
  (when @s01-health-timer (js/clearInterval @s01-health-timer))
  (reset! s01-health-timer
    (js/setInterval
      (fn []
        (when (and (= repo (state/get-current-repo)) (s01/enabled? repo)
                   (not (state/editor-in-composition?)) (not (state/loading-files? repo)))
          (try
            (let [health (s01/call! repo "health" {})]
              (when (or (:reset health) (not= (:generation health) (get @s01-cache-generations repo)))
                (swap! s01-cache-generations assoc repo (:generation health))
                (state/pub-event! [:s01/reconcile-cache repo]))
              (when (:recovery health) (state/pub-event! [:s01/show-conflicts repo])))
            (catch :default e
              (js/clearInterval @s01-health-timer)
              (notification/show! (str "ID 캐시 점검 실패: " e) :error))))) 5000)))

(defmethod handle :s01/prune-journals [[_ repo]]
  (let [records (s01/call! repo "journals" {})]
    (state/set-modal!
      (fn [] [:div.p-4 [:h2 "일반 저장 저널 정리"]
              [:p (str (count records) "개 · " (reduce + 0 (map :bytes records)) " bytes")]
              [:p "정상 저장의 이전 버전만 삭제합니다. 미해결·해결된 충돌 복구본은 유지합니다."]
              (for [record records] [:div {:key (:id record)} (:path record) " · " (:createdAt record)])
              (ui/button "표시된 일반 저장 저널 삭제" :on-click
                #(try (s01/call! repo "prune-journals" {:ids (mapv :id records)})
                      (state/close-modal!)
                      (catch :default e (notification/show! (str e) :error))))])
      {:label "s01-prune"})))

(defmethod handle :s01/show-link-plans [[_ repo]]
  (let [plans (s01/call! repo "plans" {})]
    (state/set-modal!
      (fn [] [:div.p-4 [:h2 "보관된 링크 수정안"]
              (for [plan plans]
                [:div {:key (:id plan)}
                 (ui/button (str (count (:updates plan)) "개 문서 · " (:id plan))
                   :on-click #(state/pub-event! [:s01/link-plan repo (:id plan)]))])])
      {:label "s01-plans"})))

(defmethod handle :s01/show-conflicts [[_ repo]]
  (let [records (s01/call! repo "conflicts" {})]
    (state/set-modal!
     (fn [] [:div.p-4 [:h2 "저장 충돌 목록"]
             (if (empty? records) [:p "해결할 충돌이 없습니다."]
               (for [record records]
                 [:div.my-2 {:key (:id record)}
                  (ui/button (str (:path record) " · " (:createdAt record))
                    :on-click #(state/pub-event! [:s01/conflict repo (:id record)]))]))])
     {:label "s01-conflicts"})))

(defmethod handle :s01/conflict [[_ repo id]]
  (let [record (s01/call! repo "details" {:id id})
        choose! (fn [choice]
                  (try
                    (let [result (s01/call! repo "resolve" {:id id :choice choice :observedHash (:currentHash record) :displacedHash (:displacedHash record)})]
                      (if (= "conflict" (:status result))
                        (state/pub-event! [:s01/conflict repo (:id (:conflict result))])
                        (let [path (:path result)
                              page-name (db/get-file-page path)]
                          (undo-redo/invalidate-page! repo (db/get-file-page-id path))
                          (state/clear-edit!)
                          (state/clear-selection!)
                          (if (nil? (:content result))
                            (when page-name (page-handler/delete! page-name #() :delete-file? false))
                            (file-handler/alter-file repo path (:content result)
                              {:from-disk? true :re-render-root? true :fs/event :fs/local-file-change}))
                          (state/close-modal!))))
                    (catch :default e (notification/show! (str e) :error))))]
    (when (= "pending" (:state record))
      (state/set-modal!
     (fn []
       [:div.p-4
        [:h2 "문서 충돌: " (:path record)]
        [:p "두 버전은 logseq/conflicts/에 보존됩니다. 사용할 버전을 선택해 주세요."]
        (when (and (:interrupted record) (some? (:displaced record)))
          [:div [:h3 "교체 직전 외부 버전"]
           [:textarea.w-full {:read-only true :value (:displaced record) :rows 6}]
           (ui/button "교체 직전 외부 버전 복원" :on-click #(choose! "displaced"))])
        (when (and (:interrupted record) (some? (:disk record)))
          [:div [:h3 "중단 전 디스크 원본"]
           [:textarea.w-full {:read-only true :value (:disk record) :rows 6}]
           (ui/button "중단 전 디스크 원본 복원" :on-click #(choose! "previous"))])
        [:div.flex.gap-4
         [:div.flex-1 [:h3 "앱 편집본"]
          [:textarea.w-full {:read-only true :value (:app record) :rows 14}]
          (ui/button (if (:deleted record) "편집본으로 문서 복원" "앱 편집본 사용") :on-click #(choose! "app"))]
         [:div.flex-1 [:h3 (if (:deleted record) "외부에서 삭제됨" "외부 변경본")]
          [:textarea.w-full {:read-only true :value (or (if (:interrupted record) (:currentDisk record) (:disk record)) "") :rows 14}]
          (ui/button (if (:deleted record) "삭제 유지" "외부 변경본 사용") :on-click #(choose! "disk"))]]])
     {:label "s01-conflict"}))))

(defmethod handle :file/not-matched-from-disk [[_ path disk-content db-content]]
  (state/clear-edit!)
  (when-let [repo (state/get-current-repo)]
    (when (and disk-content db-content
               (not= (util/trim-safe disk-content) (util/trim-safe db-content)))
      (state/set-modal! #(diff/local-file repo path disk-content db-content)
                        {:label "diff__cp"}))))

(defmethod handle :modal/display-file-version-selector  [[_ versions path  get-content]]
  (state/set-modal! #(git-component/file-version-selector versions path get-content)))

(defmethod handle :s01/ready [[_ repo]]
  (when (s01/enabled? repo)
    (start-s01-health! repo)
    ;; Rebuild effective feature data from authored content and durable overlays.
    (let [stored (s01/metadata-map repo)
          tx (keep (fn [[id m]]
                     (when-let [b (db/pull repo [:block/uuid (uuid id)])]
                       (when (= :markdown (:block/format b))
                         (-> (assoc b :block/content (metadata/source-content b)
                                      :block/properties (metadata/source-properties b))
                             (metadata/hydrate m)
                             (select-keys [:db/id :block/content :block/properties
                                           :block/properties-text-values :block/app-metadata]))))) stored)]
      (when (seq tx) (db-react/refresh! repo (db/transact! repo tx {:s01/index-only? true}))))
    ;; SQLite UI state outranks an older persisted renderer snapshot.
    (let [tx (keep (fn [{:keys [id collapsed]}]
                     (when-let [block (db/entity repo [:block/uuid (uuid id)])]
                       (when (and (s01/document? (get-in block [:block/page :block/file :file/path]))
                                  (not= collapsed (boolean (:block/collapsed? block))))
                         {:db/id (:db/id block) :block/collapsed? collapsed})))
                   (s01/call! repo "block-ui" {}))]
      (when (seq tx)
        (db-react/refresh! repo (db/transact! repo tx {:s01/index-only? true}))))
    (let [identities (into {} (map (juxt :path #(dissoc % :path)) (s01/call! repo "identities" {})))
          changed (keep (fn [[file _]]
                          (when (and (s01/document? file)
                                     (or (not= (s01/document-key file) (db/get-file-page file false))
                                         (not= (get identities file)
                                               (file-core/page-identity repo (db/get-file-page file))))) file))
                        (db/get-files repo))]
      (when (seq changed) (state/pub-event! [:s01/reconcile-cache repo (vec changed)])))
    (let [scan (s01/call! repo "scan" {})]
      (when (:notice scan) (state/pub-event! [:s01/reconcile-cache repo]))
      (when-let [plan (:plan scan)]
      (state/pub-event! [:s01/link-plan repo (:id plan)])))
    (when (seq (s01/call! repo "conflicts" {}))
      (state/pub-event! [:s01/show-conflicts repo]))))

;; Hook on a graph is ready to be shown to the user.
;; It's different from :graph/restored, as :graph/restored is for window reloaded
;; FIXME: config may not be loaded when the graph is ready.
(defmethod handle :graph/ready
  [[_ repo]]
  (state/pub-event! [:s01/ready repo])
  (when (config/local-db? repo)
    (p/let [dir               (config/get-repo-dir repo)
            dir-exists?       (fs/dir-exists? dir)]
      (when (and (not dir-exists?)
                 (not util/nfs?))
        (state/pub-event! [:graph/dir-gone dir]))))
  (p/let [loaded-homepage-files (fs-watcher/preload-graph-homepage-files!)
          ;; re-render-root is async and delegated to rum, so we need to wait for main ui to refresh
          _ (js/setTimeout #(mobile/mobile-postinit) 1000)
          ;; FIXME: an ugly implementation for redirecting to page on new window is restored
          _ (repo-handler/graph-ready! repo)
          _ (fs-watcher/load-graph-files! repo loaded-homepage-files)]))

(defmethod handle :notification/show [[_ {:keys [content status clear?]}]]
  (notification/show! content status clear?))

(defmethod handle :command/run [_]
  (when (util/electron?)
    (state/set-modal! shell/shell)))

(defmethod handle :go/search [_]
  (state/set-modal! cmdk/cmdk-modal
                    {:fullscreen? true
                     :close-btn?  false
                     :panel?      false
                     :label "ls-modal-search"}))

(defmethod handle :go/plugins [_]
  (plugin/open-plugins-modal!))

(defmethod handle :go/plugins-waiting-lists [_]
  (plugin/open-waiting-updates-modal!))

(defmethod handle :go/plugins-from-file [[_ plugins]]
  (plugin/open-plugins-from-file-modal! plugins))

(defmethod handle :go/plugins-settings [[_ pid nav? title]]
  (if pid
    (do
      (state/set-state! :plugin/focused-settings pid)
      (state/set-state! :plugin/navs-settings? (not (false? nav?)))
      (plugin/open-focused-settings-modal! title))
    (state/close-sub-modal! "ls-focused-settings-modal")))

(defmethod handle :go/proxy-settings [[_ agent-opts]]
  (state/set-sub-modal!
   (fn [_] (plugin/user-proxy-settings-panel agent-opts))
   {:id :https-proxy-panel :center? true}))

(defmethod handle :redirect-to-home [_]
  (page-handler/create-today-journal!))

(defmethod handle :instrument [[_ {:keys [type payload] :as opts}]]
  (when-not (empty? (dissoc opts :type :payload))
    (js/console.error "instrument data-map should only contains [:type :payload]"))
  (posthog/capture type payload))

(defmethod handle :capture-error [[_ {:keys [error payload]}]]
  (let [[user-uuid graph-uuid tx-id] @sync/graphs-txid
        payload (assoc payload
                       :user-id user-uuid
                       :graph-id graph-uuid
                       :tx-id tx-id)]
    (Sentry/captureException error
                             (bean/->js {:tags payload}))))

(defmethod handle :exec-plugin-cmd [[_ {:keys [pid cmd action]}]]
  (commands/exec-plugin-simple-command! pid cmd action))

(defmethod handle :shortcut-handler-refreshed [[_]]
  (when-not @st/*pending-inited?
    (reset! st/*pending-inited? true)
    (st/consume-pending-shortcuts!)))

(defmethod handle :mobile/keyboard-will-show [[_ keyboard-height]]
  (let [main-node (util/app-scroll-container-node)]
    (state/set-state! :mobile/show-tabbar? false)
    (state/set-state! :mobile/show-toolbar? true)
    (state/set-state! :mobile/show-action-bar? false)
    (when (= (state/sub :editor/record-status) "RECORDING")
      (state/set-state! :mobile/show-recording-bar? true))
    (when (mobile-util/native-ios?)
      (reset! util/keyboard-height keyboard-height)
      (set! (.. main-node -style -marginBottom) (str keyboard-height "px"))
      (when-let [^js html (js/document.querySelector ":root")]
        (.setProperty (.-style html) "--ls-native-kb-height" (str keyboard-height "px"))
        (.add (.-classList html) "has-mobile-keyboard"))
      (when-let [left-sidebar-node (gdom/getElement "left-sidebar")]
        (set! (.. left-sidebar-node -style -bottom) (str keyboard-height "px")))
      (when-let [right-sidebar-node (gdom/getElementByClass "sidebar-item-list")]
        (set! (.. right-sidebar-node -style -paddingBottom) (str (+ 150 keyboard-height) "px")))
      (when-let [card-preview-el (js/document.querySelector ".cards-review")]
        (set! (.. card-preview-el -style -marginBottom) (str keyboard-height "px")))
      (when-let [card-preview-el (js/document.querySelector ".encryption-password")]
        (set! (.. card-preview-el -style -marginBottom) (str keyboard-height "px")))
      (js/setTimeout (fn []
                       (when-let [toolbar (.querySelector main-node "#mobile-editor-toolbar")]
                         (set! (.. toolbar -style -bottom) (str keyboard-height "px"))))
                     100))))

(defmethod handle :mobile/keyboard-will-hide [[_]]
  (let [main-node (util/app-scroll-container-node)]
    (state/set-state! :mobile/show-toolbar? false)
    (state/set-state! :mobile/show-tabbar? true)
    (when (= (state/sub :editor/record-status) "RECORDING")
      (state/set-state! :mobile/show-recording-bar? false))
    (when (mobile-util/native-ios?)
      (when-let [^js html (js/document.querySelector ":root")]
        (.removeProperty (.-style html) "--ls-native-kb-height")
        (.remove (.-classList html) "has-mobile-keyboard"))
      (when-let [card-preview-el (js/document.querySelector ".cards-review")]
        (set! (.. card-preview-el -style -marginBottom) "0px"))
      (when-let [card-preview-el (js/document.querySelector ".encryption-password")]
        (set! (.. card-preview-el -style -marginBottom) "0px"))
      (set! (.. main-node -style -marginBottom) "0px")
      (when-let [left-sidebar-node (gdom/getElement "left-sidebar")]
        (set! (.. left-sidebar-node -style -bottom) "0px"))
      (when-let [right-sidebar-node (gdom/getElementByClass "sidebar-item-list")]
        (set! (.. right-sidebar-node -style -paddingBottom) "150px"))
      (when-let [toolbar (.querySelector main-node "#mobile-editor-toolbar")]
        (set! (.. toolbar -style -bottom) 0)))))

(defn- get-ios-app-id
  [repo-url]
  (when repo-url
    (let [app-id (-> (first (string/split repo-url "/Documents"))
                     (string/split "/")
                     last)]
      app-id)))

(defmethod handle :validate-appId [[_ graph-switch-f graph]]
  (when-let [deprecated-repo (or graph (state/get-current-repo))]
    (if (mobile-util/in-iCloud-container-path? deprecated-repo)
      ;; Installation is not changed for iCloud
      (when graph-switch-f
        (graph-switch-f graph true)
        (state/pub-event! [:graph/ready (state/get-current-repo)]))
      ;; Installation is changed for App Documents directory
      (p/let [deprecated-app-id (get-ios-app-id deprecated-repo)
              current-document-url (.getUri Filesystem #js {:path ""
                                                            :directory (.-Documents Directory)})
              current-app-id (-> (js->clj current-document-url :keywordize-keys true)
                                 get-ios-app-id)]
        (if (= deprecated-app-id current-app-id)
          (when graph-switch-f (graph-switch-f graph true))
          (do
            (notification/show! [:div "Migrating from previous App installation..."]
                                :warning
                                true)
            (prn ::migrate-app-id :from deprecated-app-id :to current-app-id)
            (file-sync-stop!)
            (.unwatch mobile-util/fs-watcher)
            (let [current-repo (string/replace deprecated-repo deprecated-app-id current-app-id)
                  current-repo-dir (config/get-repo-dir current-repo)]
              (try
                ;; replace app-id part of repo url
                (reset! conn/conns
                        (update-keys @conn/conns
                                     (fn [key]
                                       (if (string/includes? key deprecated-app-id)
                                         (string/replace key deprecated-app-id current-app-id)
                                         key))))
                (db-persist/rename-graph! deprecated-repo current-repo)
                (search/remove-db! deprecated-repo)
                (state/add-repo! {:url current-repo :nfs? true})
                (state/delete-repo! {:url deprecated-repo})
                (catch :default e
                  (js/console.error e)))
              (state/set-current-repo! current-repo)
              (db/listen-and-persist! current-repo)
              (db/persist-if-idle! current-repo)
              (repo-config-handler/restore-repo-config! current-repo)
              (when graph-switch-f (graph-switch-f current-repo true))
              (.watch mobile-util/fs-watcher #js {:path current-repo-dir})
              (file-sync-restart!))))
        (state/pub-event! [:graph/ready (state/get-current-repo)])))))

(defmethod handle :plugin/consume-updates [[_ id prev-pending? updated?]]
  (let [downloading?   (:plugin/updates-downloading? @state/state)
        auto-checking? (plugin-handler/get-auto-checking?)]
    (when-let [coming (and (not downloading?)
                           (get-in @state/state [:plugin/updates-coming id]))]
      (let [error-code (:error-code coming)
            error-code (if (= error-code (str :no-new-version)) nil error-code)
            title      (:title coming)]
        (when (and prev-pending? (not auto-checking?))
          (if-not error-code
            (plugin/set-updates-sub-content! (str title "...") 0)
            (notification/show!
             (str "[Checked]<" title "> " error-code) :error)))))

    (if (and updated? downloading?)
      ;; try to start consume downloading item
      (if-let [next-coming (state/get-next-selected-coming-update)]
        (plugin-handler/check-or-update-marketplace-plugin!
         (assoc next-coming :only-check false :error-code nil)
         (fn [^js e] (js/console.error "[Download Err]" next-coming e)))
        (plugin-handler/close-updates-downloading))

      ;; try to start consume pending item
      (if-let [next-pending (second (first (:plugin/updates-pending @state/state)))]
        (do
          (println "Updates: take next pending - " (:id next-pending))
          (js/setTimeout
           #(plugin-handler/check-or-update-marketplace-plugin!
             (assoc next-pending :only-check true :auto-check auto-checking? :error-code nil)
             (fn [^js e]
               (notification/show! (.toString e) :error)
               (js/console.error "[Check Err]" next-pending e))) 500))

        ;; try to open waiting updates list
        (do (when (and prev-pending? (not auto-checking?)
                       (seq (state/all-available-coming-updates)))
              (plugin/open-waiting-updates-modal!))
            (plugin-handler/set-auto-checking! false))))))

(defmethod handle :plugin/hook-db-tx [[_ {:keys [blocks tx-data] :as payload}]]
  (when-let [payload (and (seq blocks)
                          (merge payload {:tx-data (map #(into [] %) tx-data)}))]
    (plugin-handler/hook-plugin-db :changed payload)
    (plugin-handler/hook-plugin-block-changes payload)))

(defmethod handle :plugin/loader-perf-tip [[_ {:keys [^js o _s _e]}]]
  (when-let [opts (.-options o)]
    (notification/show!
     (plugin/perf-tip-content (.-id o) (.-name opts) (.-url opts))
     :warning false (.-id o))))

(defmethod handle :mobile-file-watcher/changed [[_ ^js event]]
  (let [type (.-event event)
        payload (js->clj event :keywordize-keys true)]
    (fs-watcher/handle-changed! type payload)
    (when (file-sync-handler/enable-sync?)
      (sync/file-watch-handler type payload))))

(defmethod handle :rebuild-slash-commands-list [[_]]
  (page-handler/rebuild-slash-commands-list!))

(defmethod handle :shortcut/refresh [[_]]
  (st/refresh!))

(defn- refresh-cb []
  (page-handler/create-today-journal!)
  (file-sync-restart!))

(defmethod handle :graph/ask-for-re-fresh [_]
  (handle
   [:modal/show
    [:div {:style {:max-width 700}}
     [:p (t :sync-from-local-changes-detected)]
     (ui/button
      (t :yes)
      :autoFocus "on"
      :class "ui__modal-enter"
      :on-click (fn []
                  (state/close-modal!)
                  (nfs-handler/refresh! (state/get-current-repo) refresh-cb)))]]))

(defmethod handle :sync/create-remote-graph [[_ current-repo]]
  (let [graph-name (js/decodeURI (util/node-path.basename current-repo))]
    (async/go
      (async/<! (sync/<sync-stop))
      (state/set-state! [:ui/loading? :graph/create-remote?] true)
      (when-let [GraphUUID (get (async/<! (file-sync-handler/create-graph graph-name)) 2)]
        (async/<! (sync/<sync-start))
        (state/set-state! [:ui/loading? :graph/create-remote?] false)
        ;; update existing repo
        (state/set-repos! (map (fn [r]
                                 (if (= (:url r) current-repo)
                                   (assoc r
                                          :GraphUUID GraphUUID
                                          :GraphName graph-name
                                          :remote? true)
                                   r))
                               (state/get-repos)))))))

(defmethod handle :graph/re-index [[_]]
  ;; Ensure the graph only has ONE window instance
  (async/go
    (async/<! (sync/<sync-stop))
    (repo-handler/re-index!
     nfs-handler/rebuild-index!
     #(do (page-handler/create-today-journal!)
          (file-sync-restart!)))))

;; FIXME: move
(defn- clear-cache!
  []
  (notification/show! "Clearing..." :warning false)
  (p/let [_ (when (util/electron?)
              (ipc/ipc "clearCache"))
          _ (idb/clear-local-storage-and-idb!)]
    (js/setTimeout
     (fn [] (if (util/electron?)
              (ipc/ipc :reloadWindowPage)
              (js/window.location.reload)))
     2000)))

(defmethod handle :graph/clear-cache! [[_]]
  (clear-cache!))

(defmethod handle :graph/ask-for-re-index [[_ *multiple-windows? ui]]
  ;; *multiple-windows? - if the graph is opened in multiple windows, boolean atom
  ;; ui - custom message to show on asking for re-index
  (if (and (util/atom? *multiple-windows?) @*multiple-windows?)
    (handle
     [:modal/show
      [:div
       (when (not (nil? ui)) ui)
       [:p (t :re-index-multiple-windows-warning)]]])
    (handle
     [:modal/show
      [:div {:style {:max-width 700}}
       (when (not (nil? ui)) ui)
       [:p (t :re-index-discard-unsaved-changes-warning)]
       (ui/button
        (t :yes)
        :autoFocus "on"
        :class "ui__modal-enter"
        :on-click (fn []
                    (state/close-modal!)
                    (state/pub-event! [:graph/re-index])))]])))

(defmethod handle :modal/remote-encryption-input-pw-dialog [[_ repo-url remote-graph-info type opts]]
  (state/set-modal!
   (encryption/input-password
    repo-url nil (merge
                  (assoc remote-graph-info
                         :type (or type :create-pwd-remote)
                         :repo repo-url)
                  opts))
   {:center? true :close-btn? false :close-backdrop? false}))

(defmethod handle :journal/insert-template [[_ page-name]]
  (let [page-name (util/page-name-sanity-lc page-name)]
    (when-let [page (db/pull [:block/name page-name])]
      (when (db/page-empty? (state/get-current-repo) page-name)
        (when-let [template (state/get-default-journal-template)]
          (editor-handler/insert-template!
           nil
           template
           {:target page}))))))

(defmethod handle :editor/set-org-mode-heading [[_ block heading]]
  (when-let [id (:block/uuid block)]
    (editor-handler/set-heading! id heading)))

(defmethod handle :file-sync-graph/restore-file [[_ graph page-entity content]]
  (when (db/get-db graph)
    (let [file (:block/file page-entity)]
      (when-let [path (:file/path file)]
        (when (and (not= content (:file/content file))
                   (:file/content file))
          (sync/add-new-version-file graph path (:file/content file)))
        (p/let [_ (file-handler/alter-file graph
                                           path
                                           content
                                           {:re-render-root? true
                                            :skip-compare? true})]
          (state/close-modal!)
          (route-handler/redirect! {:to :page
                                    :path-params {:name (:block/name page-entity)}}))))))

(defmethod handle :whiteboard/onboarding [[_ opts]]
  (state/set-modal!
   (fn [close-fn] (whiteboard/onboarding-welcome close-fn))
   (merge {:close-btn?      false
           :center?         true
           :close-backdrop? false} opts)))

(defmethod handle :file-sync/onboarding-tip [[_ type opts]]
  (let [type (keyword type)]
    (state/set-modal!
     (file-sync/make-onboarding-panel type)
     (merge {:close-btn?      false
             :center?         true
             :close-backdrop? (not= type :welcome)} opts))))

(defmethod handle :file-sync/maybe-onboarding-show [[_ type]]
  (file-sync/maybe-onboarding-show type))

(defmethod handle :file-sync/storage-exceed-limit [[_]]
  (notification/show! "file sync storage exceed limit" :warning false)
  (file-sync-stop!))

(defmethod handle :file-sync/graph-count-exceed-limit [[_]]
  (notification/show! "file sync graph count exceed limit" :warning false)
  (file-sync-stop!))

(defmethod handle :graph/restored [[_ _graph]]
  (mobile/init!)
  (when-not (mobile-util/native-ios?)
    (state/pub-event! [:graph/ready (state/get-current-repo)])))

(defmethod handle :whiteboard-link [[_ shapes]]
  (route-handler/go-to-search! :whiteboard/link)
  (state/set-state! :whiteboard/linked-shapes shapes))

(defmethod handle :whiteboard-go-to-link [[_ link]]
  (route-handler/redirect! {:to :whiteboard
                            :path-params {:name link}}))

(defmethod handle :graph/dir-gone [[_ dir]]
  (state/pub-event! [:notification/show
                     {:content (str "The directory " dir " has been renamed or deleted, the editor will be disabled for this graph, you can unlink the graph.")
                      :status :error
                      :clear? false}])
  (state/update-state! :file/unlinked-dirs (fn [dirs] (conj dirs dir))))

(defmethod handle :graph/dir-back [[_ repo dir]]
  (when (contains? (:file/unlinked-dirs @state/state) dir)
    (notification/clear-all!)
    (state/pub-event! [:notification/show
                       {:content (str "The directory " dir " has been back, you can edit your graph now.")
                        :status :success
                        :clear? true}])
    (state/update-state! :file/unlinked-dirs (fn [dirs] (disj dirs dir)))
    (when (= dir (config/get-repo-dir repo))
      (fs/watch-dir! dir))))

(defmethod handle :ui/notify-outdated-filename-format [[_ paths]]
  ;; paths - the affected paths that contains reserved characters
  (notification/show!
   [:div
    [:div.mb-4
     [:div.font-semibold.mb-4.text-xl "It seems that some of your filenames are in the outdated format."]

     [:div
      [:p
       "We suggest you upgrade now to avoid potential bugs."]
      (when (seq paths)
        [:p
         "For example, the files below have reserved characters that can't be synced on some platforms."])]]
    (ui/button
     "Update filename format"
     :aria-label "Update filename format"
     :on-click (fn []
                 (notification/clear-all!)
                 (state/set-modal!
                  (fn [_] (conversion-component/files-breaking-changed))
                  {:id :filename-format-panel :center? true})))
    (when (seq paths)
      [:ol.my-2
       (for [path paths]
         [:li path])])]
   :warning
   false))

(defmethod handle :ui/notify-skipped-downloading-files [[_ paths]]
  (notification/show!
   [:div
    [:div.mb-4
     [:div.font-semibold.mb-4.text-xl "It seems that some of your filenames are in the outdated format."]
     [:p
      "The files below that have reserved characters can't be saved on this device."]
     [:div.overflow-y-auto.max-h-96
      [:ol.my-2
       (for [path paths]
         [:li path])]]

     [:div
      [:p
       "Check " [:a {:href "https://docs.logseq.com/#/page/logseq%20file%20and%20folder%20naming%20rules"
                     :target "_blank"}
                 "Logseq file and folder naming rules"]
       " for more details."]
      [:p
       (util/format "To solve this problem, we suggest you quit Logseq and update the filename format (on Settings > Advanced > Filename format > click EDIT button)%s to avoid more potential bugs."
                    (if (and util/mac? (not (mobile-util/native-ios?)))
                      ""
                      " in other devices"))]]]]
   :warning
   false))

(defmethod handle :graph/setup-a-repo [[_ opts]]
  (let [opts' (merge {:picked-root-fn #(state/close-modal!)
                      :native-icloud? (not (string/blank? (state/get-icloud-container-root-url)))
                      :logged?        (user-handler/logged-in?)} opts)]
    (if (mobile-util/native-ios?)
      (state/set-modal!
       #(graph-picker/graph-picker-cp opts')
       {:label "graph-setup"})
      (page-handler/ls-dir-files! st/refresh! opts'))))

(defmethod handle :file/alter [[_ repo path content]]
  (p/let [_ (file-handler/alter-file repo path content {:from-disk? true})]
    (ui-handler/re-render-root!)))

(rum/defcs file-id-conflict-item <
  (rum/local false ::resolved?)
  [state repo file data]
  (let [resolved? (::resolved? state)
        id (last (:assertion data))]
    [:li {:key file}
     [:div
      [:a {:on-click #(js/window.apis.openPath file)} file]
      (if @resolved?
        [:div.flex.flex-row.items-center
         (ui/icon "circle-check" {:style {:font-size 20}})
         [:div.ml-1 "Resolved"]]
        [:div
         [:p
          (str "It seems that another whiteboard file already has the ID \"" id
               "\". You can fix it by changing the ID in this file with another UUID.")]
         [:p
          "Or, let me"
          (ui/button "Fix"
                     :on-click (fn []
                                 (let [dir (config/get-repo-dir repo)]
                                   (p/let [content (fs/read-file dir file)]
                                     (let [new-content (string/replace content (str id) (str (random-uuid)))]
                                       (p/let [_ (fs/write-plain-text-file! repo
                                                                            dir
                                                                            file
                                                                            new-content
                                                                            {})]
                                         (reset! resolved? true))))))
                     :class "inline mx-1")
          "it."]])]]))

(defmethod handle :file/parse-and-load-error [[_ repo parse-errors]]
  (state/pub-event! [:notification/show
                     {:content
                      [:div
                       [:h2.title "Oops. These files failed to import to your graph:"]
                       [:ol.my-2
                        (for [[file error] parse-errors]
                          (let [data (ex-data error)]
                            (cond
                              (and (gp-config/whiteboard? file)
                                   (= :transact/upsert (:error data))
                                   (uuid? (last (:assertion data))))
                              (rum/with-key (file-id-conflict-item repo file data) file)

                              :else
                              (do
                                (state/pub-event! [:capture-error {:error error
                                                                   :payload {:type :file/parse-and-load-error}}])
                                [:li.my-1 {:key file}
                                 [:a {:on-click #(js/window.apis.openPath file)} file]
                                 [:p (.-message error)]]))))]
                       [:p "Don't forget to re-index your graph when all the conflicts are resolved."]]
                      :status :error}]))

(defmethod handle :run/cli-command [[_ command content]]
  (when (and command (not (string/blank? content)))
    (shell-handler/run-cli-command-wrapper! command content)))

(defmethod handle :whiteboard/undo [[_ e]]
  (whiteboard-handler/undo! e))

(defmethod handle :whiteboard/redo [[_ e]]
  (whiteboard-handler/redo! e))

(defmethod handle :editor/quick-capture [[_ args]]
  (quick-capture/quick-capture args))

(defmethod handle :modal/keymap [[_]]
  (state/open-settings! :keymap))

(defmethod handle :editor/toggle-own-number-list [[_ blocks]]
  (let [batch? (sequential? blocks)
        blocks (cond->> blocks
                 batch?
                 (map #(cond-> % (or (uuid? %) (string? %)) (db-model/get-block-by-uuid))))]
    (if (and batch? (> (count blocks) 1))
      (editor-handler/toggle-blocks-as-own-order-list! blocks)
      (when-let [block (cond-> blocks batch? (first))]
        (if (editor-handler/own-order-number-list? block)
          (editor-handler/remove-block-own-order-list-type! block)
          (editor-handler/make-block-as-own-order-list! block))))))

(defmethod handle :editor/remove-own-number-list [[_ block]]
  (when (some-> block (editor-handler/own-order-number-list?))
    (editor-handler/remove-block-own-order-list-type! block)))

(defmethod handle :editor/toggle-children-number-list [[_ block]]
  (when-let [blocks (and block (db-model/get-block-immediate-children (state/get-current-repo) (:block/uuid block)))]
    (editor-handler/toggle-blocks-as-own-order-list! blocks)))

(defn run!
  []
  (let [chan (state/get-events-chan)]
    (async/go-loop []
      (let [[payload d] (async/<! chan)]
        (->
         (try
           (p/resolved (handle payload))
           (catch :default error
             (p/rejected error)))
         (p/then (fn [result]
                   (p/resolve! d result)))
         (p/catch (fn [error]
                    (let [type :handle-system-events/failed]
                      (state/pub-event! [:capture-error {:error error
                                                         :payload {:type type
                                                                   :payload payload}}])
                      (p/reject! d error))))))
      (recur))
    chan))

(comment
  (let [{:keys [deprecated-app-id current-app-id]} {:deprecated-app-id "AFDADF9A-7466-4ED8-B74F-AAAA0D4565B9", :current-app-id "7563518E-0EFD-4AD2-8577-10CFFD6E4596"}]
    (def deprecated-app-id deprecated-app-id)
    (def current-app-id current-app-id))
  (def deprecated-repo (state/get-current-repo))
  (def new-repo (string/replace deprecated-repo deprecated-app-id current-app-id))

  (update-file-path deprecated-repo new-repo deprecated-app-id current-app-id))
