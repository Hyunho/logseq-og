(ns frontend.components.raw-file
  "Read-only inspection of the saved file, without parsing or normalization."
  (:require [frontend.config :as config]
            [frontend.context.i18n :refer [t]]
            [frontend.fs :as fs]
            [frontend.state :as state]
            [frontend.ui :as ui]
            [frontend.util :as util]
            [logseq.common.path :as path]
            [promesa.core :as p]
            [rum.core :as rum]))

(rum/defc viewer
  [repo file-path]
  (let [[result set-result!] (rum/use-state {:loading? true})
        [revision set-revision!] (rum/use-state 0)
        {:keys [loading? content error]} result]
    (rum/use-effect!
     (fn []
       (let [active? (atom true)
             dir (when-not (path/absolute? file-path) (config/get-repo-dir repo))]
         (set-result! {:loading? true})
         (-> (p/let [text (fs/read-file dir file-path)]
               (when @active?
                 (set-result! (if (string? text)
                                {:content text}
                                {:error (t :file/raw-read-error)}))))
             (p/catch (fn [_error]
                        (when @active?
                          (set-result! {:error (t :file/raw-read-error)})))))
         #(reset! active? false)))
     [repo file-path revision])
    [:div.raw-file-viewer
     [:h2.text-xl.font-semibold (t :file/view-raw)]
     [:div.text-sm.my-2 {:style {:overflow-wrap "anywhere"}} file-path]
     [:p.text-sm.opacity-70.mb-4 (t :file/raw-description)]
     [:div.flex.gap-2.mb-4
      (ui/button (t :file/raw-refresh)
                 :disabled? loading?
                 :on-click #(do (set-result! {:loading? true})
                                (set-revision! (inc revision))))
      (ui/button (t :export-copy-to-clipboard)
                 :disabled? (or loading? (nil? content))
                 :on-click #(util/copy-to-clipboard! content))]
     (cond
       loading? (ui/loading)
       error [:p.text-error {:role "alert"} error]
       :else [:pre.p-4.bg-base-2.rounded
              {:tab-index 0
               :aria-label (t :file/view-raw)
               :style {:max-height "60vh"
                       :overflow "auto"
                       :white-space "pre"
                       :user-select "text"}}
              content])]))

(defn show!
  [repo file-path]
  (state/set-modal! (fn [] (viewer repo file-path))
                    {:label (t :file/view-raw)
                     :close-btn? true}))
