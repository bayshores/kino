import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, shareToken } from "./client.js";
import { loadViewerFonts } from "./browserFonts.js";
import { defaultFonts } from "../engine/fonts.js";
import { getSetting } from "./browserStorage.js";
import { createPresenceChannel } from "./collaborationPresence.js";
import { connectionIndicator, isRetryable, retryDelay } from "../engine/saveConnection.js";

function browserOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * A viewer never opens an editor save, history, or recovery pipeline. It also keeps the file's
 * comments: the server sends the whole list after every join and after every comment change
 * ({type: "comments"}), so a reconnect catches up by itself.
 */
export function useViewerDocument(projectId) {
  const [state, setState] = useState(() => ({
    document: null,
    fontVersion: 0,
    error: "",
    unavailable: false,
    connected: false,
    socketState: "connecting",
    lastRequestError: null,
    nativeServiceStatus: null,
    browserOnline: browserOnline(),
  }));
  const [presence] = useState(createPresenceChannel);
  const [comments, setComments] = useState([]);
  // Sends a new display name to the people in the file (set while a socket is open).
  const rename = useRef(null);
  const roster = useSyncExternalStore(presence.subscribe, presence.getRoster);
  const announceName = useCallback((name) => rename.current?.(name), []);

  useEffect(() => {
    let stopped = false;
    let socket = null;
    let socketRetry = null;
    let refreshRetry = null;
    let socketRetryAttempt = 0;
    let refreshRetryAttempt = 0;
    let activeRequest = null;
    let refreshQueued = false;
    let pending = null;
    let processing = false;
    let highestRevision = -1;
    let restartGeneration = 0;
    let nativeRestarting = false;
    let serviceStatus = null;

    const desktopBridge = globalThis.kinoDesktop;
    const hasNativeStatus = typeof desktopBridge?.onServiceStatus === "function";
    const clientId = crypto.randomUUID();
    let announced = getSetting("name") || "Guest";
    setComments([]);
    // Joining again with the same client ID renames this session in everyone's presence list.
    rename.current = (value) => {
      const name = value || "Guest";
      if (name === announced || socket?.readyState !== WebSocket.OPEN) return;
      announced = name;
      socket.send(JSON.stringify({ type: "join", projectId, clientId, name }));
    };
    setState({
      document: null,
      fontVersion: 0,
      error: "",
      unavailable: false,
      connected: false,
      socketState: "connecting",
      lastRequestError: null,
      nativeServiceStatus: null,
      browserOnline: browserOnline(),
    });

    function clearRetryTimers() {
      if (socketRetry !== null) clearTimeout(socketRetry);
      if (refreshRetry !== null) clearTimeout(refreshRetry);
      socketRetry = null;
      refreshRetry = null;
    }

    function setSocketState(socketState) {
      setState((current) => ({ ...current, socketState, connected: socketState === "connected" }));
    }

    function isCurrentGeneration(generation) {
      return !stopped && generation === restartGeneration;
    }

    function disconnectSocket() {
      const current = socket;
      socket = null;
      presence.disconnect(current ?? undefined);
      current?.close();
    }

    function unavailable(problem = null) {
      if (stopped) return;
      stopped = true;
      clearRetryTimers();
      refreshQueued = false;
      activeRequest?.controller.abort();
      activeRequest = null;
      disconnectSocket();
      setState((current) => ({
        ...current,
        document: null,
        fontVersion: 0,
        error: "This link no longer works.",
        unavailable: true,
        connected: false,
        socketState: "disconnected",
        lastRequestError: problem,
      }));
    }

    function scheduleRefreshRetry() {
      if (stopped || nativeRestarting || serviceStatus === "failed" || refreshRetry !== null) return;
      const delay = retryDelay(refreshRetryAttempt);
      refreshRetryAttempt += 1;
      refreshRetry = setTimeout(() => {
        refreshRetry = null;
        void refresh();
      }, delay);
    }

    function failed(problem, generation) {
      if (!isCurrentGeneration(generation) || problem?.name === "AbortError") return;
      // A local service restart briefly invalidates the owner cookie. The ready
      // notification will retry against the new service before access is judged.
      if (nativeRestarting || serviceStatus === "reconnecting") return;
      if ([403, 404, 410].includes(problem?.status)) {
        unavailable(problem);
        return;
      }
      setState((current) => ({
        ...current,
        error: "The file could not be loaded. Check the connection and try again.",
        lastRequestError: problem,
      }));
      if (isRetryable(problem)) scheduleRefreshRetry();
      else if (refreshRetry !== null) {
        clearTimeout(refreshRetry);
        refreshRetry = null;
      }
    }

    async function receive(record, generation) {
      if (!isCurrentGeneration(generation) || nativeRestarting || record?.document?.id !== projectId ||
          !Number.isFinite(record.revision) || record.revision < highestRevision) return false;
      highestRevision = record.revision;
      pending = { record, generation };
      if (processing) return true;
      processing = true;
      let processingGeneration = generation;
      try {
        while (!stopped && pending) {
          const next = pending;
          pending = null;
          processingGeneration = next.generation;
          if (!isCurrentGeneration(next.generation) || nativeRestarting) continue;
          await loadViewerFonts(next.record.document);
          if (!isCurrentGeneration(next.generation) || nativeRestarting) continue;
          if (pending && pending.record.revision > next.record.revision) continue;
          setState((current) => ({
            ...current,
            document: next.record.document,
            revision: next.record.revision,
            fontVersion: defaultFonts.version,
            error: "",
            lastRequestError: null,
          }));
        }
        return true;
      } catch (problem) {
        failed(problem, processingGeneration);
        return false;
      } finally {
        processing = false;
        // A newer broadcast may have arrived while fonts for the previous one loaded.
        if (!stopped && pending) void receive(pending.record, pending.generation);
      }
    }

    function refresh() {
      if (stopped || nativeRestarting || serviceStatus === "failed") return Promise.resolve();
      if (activeRequest) {
        refreshQueued = true;
        return activeRequest.promise;
      }

      const generation = restartGeneration;
      const controller = new AbortController();
      const request = { controller, generation, promise: null };
      activeRequest = request;
      request.promise = (async () => {
        try {
          const record = await api("/shared-project", { signal: controller.signal });
          if (!isCurrentGeneration(generation) || controller.signal.aborted || nativeRestarting) return;
          const received = await receive(record, generation);
          if (!received || !isCurrentGeneration(generation) || nativeRestarting) return;
          refreshRetryAttempt = 0;
          if (refreshRetry !== null) clearTimeout(refreshRetry);
          refreshRetry = null;
        } catch (problem) {
          failed(problem, generation);
        } finally {
          if (activeRequest === request) activeRequest = null;
          if (refreshQueued && !stopped && !nativeRestarting && serviceStatus !== "failed") {
            refreshQueued = false;
            void refresh();
          }
        }
      })();
      return request.promise;
    }

    function scheduleSocketReconnect() {
      if (stopped || nativeRestarting || serviceStatus === "failed" || socketRetry !== null) return;
      const delay = retryDelay(socketRetryAttempt);
      socketRetryAttempt += 1;
      socketRetry = setTimeout(() => {
        socketRetry = null;
        connect();
      }, delay);
    }

    function connect() {
      if (stopped || nativeRestarting || serviceStatus === "failed") return;
      if (socket && socket.readyState < WebSocket.CLOSING) return;

      const generation = restartGeneration;
      const token = shareToken();
      const current = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collaboration?share=${encodeURIComponent(token)}`);
      socket = current;
      presence.connect(current, projectId);
      setSocketState("connecting");

      current.onopen = () => {
        if (!isCurrentGeneration(generation) || socket !== current || nativeRestarting) {
          current.close();
          return;
        }
        try {
          announced = getSetting("name") || "Guest";
          current.send(JSON.stringify({ type: "join", projectId, clientId, name: announced }));
        } catch {
          current.close();
          return;
        }
        socketRetryAttempt = 0;
        if (socketRetry !== null) clearTimeout(socketRetry);
        socketRetry = null;
        setSocketState("connected");
        void refresh();
      };

      current.onmessage = ({ data }) => {
        if (!isCurrentGeneration(generation) || socket !== current || nativeRestarting) return;
        let message;
        try { message = JSON.parse(data); } catch { return; }
        presence.receive(message);
        if (message.type === "document") void receive(message, generation);
        if (message.type === "comments" && Array.isArray(message.comments)) setComments(message.comments);
        if (message.type === "project-lifecycle" && message.projectId === projectId &&
            ["trashed", "deleted"].includes(message.state)) unavailable();
      };

      current.onclose = ({ code }) => {
        presence.disconnect(current);
        if (socket !== current || stopped) return;
        socket = null;
        if (!isCurrentGeneration(generation) || nativeRestarting) return;
        setSocketState("disconnected");
        // A 1008 during a native restart can be the expired local owner session.
        // Outside that restart window it means this share link is no longer valid.
        if (code === 1008) {
          if (serviceStatus === "reconnecting") return;
          unavailable();
          return;
        }
        void refresh();
        scheduleSocketReconnect();
      };
    }

    function onNativeServiceStatus(nextStatus) {
      if (!hasNativeStatus || !["ready", "reconnecting", "failed"].includes(nextStatus) || stopped) return;
      const previousStatus = serviceStatus;

      if (nextStatus === "reconnecting") {
        if (!nativeRestarting) restartGeneration += 1;
        nativeRestarting = true;
        serviceStatus = nextStatus;
        clearRetryTimers();
        refreshQueued = false;
        activeRequest?.controller.abort();
        pending = null;
        disconnectSocket();
        setState((current) => ({
          ...current,
          connected: false,
          socketState: "connecting",
          nativeServiceStatus: "reconnecting",
          error: "",
          lastRequestError: null,
        }));
        return;
      }

      if (nextStatus === "failed") {
        if (serviceStatus !== "failed") restartGeneration += 1;
        nativeRestarting = false;
        serviceStatus = nextStatus;
        clearRetryTimers();
        refreshQueued = false;
        activeRequest?.controller.abort();
        pending = null;
        disconnectSocket();
        const problem = Object.assign(new Error("The local service could not restart. Use Restart local service in the View menu."), { kind: "nonretryable" });
        setState((current) => ({
          ...current,
          connected: false,
          socketState: "disconnected",
          nativeServiceStatus: "failed",
          error: problem.message,
          lastRequestError: problem,
        }));
        return;
      }

      const shouldResume = nativeRestarting || previousStatus === "failed" || previousStatus === "reconnecting";
      serviceStatus = "ready";
      nativeRestarting = false;
      setState((current) => ({ ...current, nativeServiceStatus: "ready", error: "", lastRequestError: null }));
      if (shouldResume) {
        connect();
        void refresh();
      }
    }

    let removeServiceStatus = null;
    if (hasNativeStatus) {
      try {
        const unsubscribe = desktopBridge.onServiceStatus(onNativeServiceStatus);
        if (typeof unsubscribe === "function") removeServiceStatus = unsubscribe;
      } catch { /* Continue with ordinary socket and request recovery. */ }
    }

    function refreshAndReconnect() {
      void refresh();
      connect();
    }
    function onOnline() {
      if (stopped) return;
      setState((current) => ({ ...current, browserOnline: true }));
      refreshAndReconnect();
    }
    function onOffline() {
      if (stopped) return;
      // A loopback service can remain reachable without internet access, so keep
      // attempting the viewer's local requests and socket reconnection.
      setState((current) => ({ ...current, browserOnline: false }));
    }

    void refresh();
    connect();
    window.addEventListener("focus", refreshAndReconnect);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      stopped = true;
      rename.current = null;
      clearRetryTimers();
      refreshQueued = false;
      activeRequest?.controller.abort();
      activeRequest = null;
      removeServiceStatus?.();
      presence.disconnect();
      socket?.close();
      socket = null;
      window.removeEventListener("focus", refreshAndReconnect);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [projectId, presence]);

  const connectionStatus = connectionIndicator({
    saveState: state.nativeServiceStatus === "failed" ? "error" : state.document ? "read-only" : "loading",
    socketState: state.socketState,
    errorKind: state.lastRequestError,
    // navigator.onLine is advisory only: an offline browser may still reach
    // the local kino service over loopback.
    online: ["127.0.0.1", "localhost", "[::1]"].includes(globalThis.location?.hostname) || state.browserOnline,
  });

  return {
    ...state,
    connectionStatus,
    failure: state.lastRequestError?.message || (state.nativeServiceStatus === "failed" ? state.error : ""),
    presence,
    comments,
    setComments,
    people: roster.people,
    announceName,
  };
}
