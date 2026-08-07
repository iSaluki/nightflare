/**
 * Drop-in replacement for the `/socket.io/socket.io.js` client library that
 * stock Nightscout loads. The real client bundle only ever touches `io` via
 * `io.connect(opts)` / `io.connect(namespace, opts)`, returning a socket
 * with `.on(event, cb)` / `.emit(event, data, ackCb?)` — a tiny surface, so
 * rather than speaking the actual socket.io/engine.io wire protocol we
 * implement just that surface here, backed by a single plain WebSocket to
 * our RealtimeHub Durable Object (/rt). See src/durable-objects/realtime-hub.ts
 * for the server side of this envelope protocol.
 */
(function (global) {
  "use strict";

  function Emitter() {
    this._handlers = {};
  }
  Emitter.prototype.on = function (event, cb) {
    (this._handlers[event] = this._handlers[event] || []).push(cb);
    return this;
  };
  Emitter.prototype.off = function (event, cb) {
    if (!this._handlers[event]) return this;
    this._handlers[event] = this._handlers[event].filter(function (h) {
      return h !== cb;
    });
    return this;
  };
  Emitter.prototype._dispatch = function (event, data) {
    (this._handlers[event] || []).slice().forEach(function (cb) {
      try {
        cb(data);
      } catch (e) {
        console.error("io-shim handler error", e);
      }
    });
  };

  function createIO() {
    var sockets = {}; // namespace -> Emitter with an attached emit/compress
    var ws = null;
    var wsReady = false;
    var ackSeq = 1;
    var pendingAcks = {};
    var reconnectDelay = 1000;

    function dispatchAll(event, data) {
      Object.keys(sockets).forEach(function (ns) {
        sockets[ns]._dispatch(event, data);
      });
    }

    function connectWS() {
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(proto + "//" + location.host + "/rt");
      ws.onopen = function () {
        wsReady = true;
        reconnectDelay = 1000;
        dispatchAll("connect");
      };
      ws.onclose = function () {
        wsReady = false;
        dispatchAll("disconnect");
        setTimeout(connectWS, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      };
      ws.onerror = function () {};
      ws.onmessage = function (evt) {
        var msg;
        try {
          msg = JSON.parse(evt.data);
        } catch (e) {
          return;
        }
        if (msg.t === "ack") {
          var cb = pendingAcks[msg.ackId];
          if (cb) {
            delete pendingAcks[msg.ackId];
            cb(msg.data);
          }
          return;
        }
        if (msg.t === "event") {
          var sock = sockets[msg.ns || ""];
          if (sock) sock._dispatch(msg.event, msg.data);
        }
      };
    }

    function send(ns, event, data, ack) {
      var msg = { t: "event", ns: ns, event: event, data: data };
      if (ack) {
        var id = ackSeq++;
        pendingAcks[id] = ack;
        msg.ackId = id;
      }
      if (wsReady) {
        ws.send(JSON.stringify(msg));
      }
      // If not connected yet, silently drop — the real client always waits
      // for 'connect' before emitting 'authorize', so this path is rare.
    }

    function connect(nsOrOpts) {
      var ns = typeof nsOrOpts === "string" ? nsOrOpts : "";
      if (!ws) connectWS();
      if (!sockets[ns]) {
        var emitter = new Emitter();
        emitter.emit = function (event, data, ack) {
          send(ns, event, data, ack);
          return emitter;
        };
        emitter.compress = function () {
          return emitter;
        };
        emitter.disconnect = function () {
          return emitter;
        };
        sockets[ns] = emitter;
        if (wsReady) {
          setTimeout(function () {
            emitter._dispatch("connect");
          }, 0);
        }
      }
      return sockets[ns];
    }

    return { connect: connect, Manager: function () {} };
  }

  global.io = createIO();
})(window);
