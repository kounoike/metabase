(ns metabase.query-processor.streaming
  (:require [clojure.core.async :as a]
            [metabase.async.streaming-response :as streaming-response]
            [metabase.query-processor.context :as context]
            [metabase.query-processor.streaming.csv :as streaming.csv]
            [metabase.query-processor.streaming.interface :as i]
            [metabase.query-processor.streaming.json :as streaming.json]
            [metabase.query-processor.streaming.xlsx :as streaming.xlsx]
            [metabase.util :as u]
            [metabase.util.visualization-settings :as viz]
            [medley.core :as m])
  (:import clojure.core.async.impl.channels.ManyToManyChannel
           java.io.OutputStream
           metabase.async.streaming_response.StreamingResponse))

;; these are loaded for side-effects so their impls of `i/results-writer` will be available
;; TODO - consider whether we should lazy-load these!
(comment streaming.csv/keep-me
         streaming.json/keep-me
         streaming.xlsx/keep-me)

(defn- indexed-col-vis-settings [{:keys [cols visualization_settings]}]
  (vec (map (partial viz/make-format-metadata visualization_settings) cols)))

(defn- streaming-rff [results-writer]
  (fn [initial-metadata]
    (let [row-count    (volatile! 0)
          viz-settings (indexed-col-vis-settings initial-metadata)]
      (fn
        ([]
         (u/prog1 {:data (assoc initial-metadata :indexed-column-viz-settings viz-settings)}
           (i/begin! results-writer <>)))

        ([metadata]
         (-> metadata
             (assoc :row_count @row-count
                    :status    :completed)
             (m/dissoc-in [:data :visualization_settings] [:data :indexed-column-viz-settings])))

        ([metadata row]
         (let [md (assoc metadata :indexed-column-viz-settings viz-settings)]
           (i/write-row! results-writer row (dec (vswap! row-count inc)) md)
           metadata))))))

(defn- streaming-reducedf [results-writer ^OutputStream os]
  (fn [_ final-metadata context]
    (i/finish! results-writer final-metadata)
    (u/ignore-exceptions
      (.flush os)
      (.close os))
    (context/resultf final-metadata context)))

(defn streaming-context
  "Context to pass to the QP to streaming results as `export-format` to an output stream. Can be used independently of
  the normal `streaming-response` macro, which is geared toward Ring responses.

    (with-open [os ...]
      (qp/process-query query (qp.streaming/streaming-context :csv os canceled-chan)))"
  ([export-format os]
   (let [results-writer (i/streaming-results-writer export-format os)]
     {:rff      (streaming-rff results-writer)
      :reducedf (streaming-reducedf results-writer os)}))

  ([export-format os canceled-chan]
   (assoc (streaming-context export-format os) :canceled-chan canceled-chan)))

(defn- await-async-result [out-chan canceled-chan]
  ;; if we get a cancel message, close `out-chan` so the query will be canceled
  (a/go
    (when (a/<! canceled-chan)
      (a/close! out-chan)))
  ;; block until `out-chan` closes or gets a result
  (a/<!! out-chan))

(defn streaming-response*
  "Impl for `streaming-response`."
  ^StreamingResponse [export-format f]
  (streaming-response/streaming-response (i/stream-options export-format) [os canceled-chan]
    (let [result (try
                   (f (streaming-context export-format os canceled-chan))
                   (catch Throwable e
                     e))
          result (if (instance? ManyToManyChannel result)
                   (await-async-result result canceled-chan)
                   result)]
      (when (or (instance? Throwable result)
                (= (:status result) :failed))
        (streaming-response/write-error! os result)))))

(defmacro streaming-response
  "Return results of processing a query as a streaming response. This response implements the appropriate Ring/Compojure
  protocols, so return or `respond` with it directly. Pass the provided `context` to your query processor function of
  choice. `export-format` is one of `:api` (for normal JSON API responses), `:json`, `:csv`, or `:xlsx` (for downloads).

  Typical example:

    (api/defendpoint GET \"/whatever\" []
      (qp.streaming/streaming-response [context :json]
        (qp/process-query-and-save-with-max-results-constraints! (assoc query :async true) context)))

  Handles either async or sync QP results, but you should prefer returning sync results so we can handle query
  cancelations properly."
  {:style/indent 1}
  [[context-binding export-format] & body]
  `(streaming-response* ~export-format (fn [~context-binding] ~@body)))

(defn export-formats
  "Set of valid streaming response formats. Currently, `:json`, `:csv`, `:xlsx`, and `:api` (normal JSON API results
  with extra metadata), but other types may be available if plugins are installed. (The interface is extensible.)"
  []
  (set (keys (methods i/stream-options))))
