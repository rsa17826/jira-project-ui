// ==UserScript==
// @name         lib:indexeddb ls
// @version      15
// @description  IndexedDB reactive engine with array keys, structural sharing
// @license      GPLv3
// @run-at       document-start
// @author       rssaromeo
// @match        *://*/*
// @grant        none
// ==/UserScript==

;(() => {
  const lib = loadlib("libloader")

  /* =========================================================
     INDEXEDDB HELPERS
  ========================================================== */
  const idb = (() => {
    function openDB({ dbName, storeName, keyPath = "id" }) {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1)

        request.onupgradeneeded = (e) => {
          const db = e.target.result
          if (!db.objectStoreNames.contains(storeName)) {
            // keyPath is null since we handle keys manually
            db.createObjectStore(storeName, { keyPath: null })
          }
        }

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }

    async function setup({ storeName, storePrefix = "" }) {
      const dbName =
        storePrefix ? `${storePrefix}_${storeName}` : storeName
      const db = await openDB({ dbName, storeName })
      return { db, storeName }
    }

    function getStore(dbObj, mode = "readonly") {
      const tx = dbObj.db.transaction(dbObj.storeName, mode)
      return tx.objectStore(dbObj.storeName)
    }

    function getAll(dbObj) {
      return new Promise((resolve, reject) => {
        const store = getStore(dbObj, "readonly")
        const request = store.getAll()
        request.onsuccess = () => resolve(request.result || [])
        request.onerror = () => reject(request.error)
      })
    }

    function clearAll(dbObj) {
      return new Promise((resolve, reject) => {
        const store = getStore(dbObj, "readwrite")
        const request = store.clear()
        request.onsuccess = () => resolve(true)
        request.onerror = () => reject(request.error)
      })
    }

    return { setup, getAll, clearAll }
  })()

  /* =========================================================
     MAIN LIB
  ========================================================== */
  lib.savelib(
    "indexeddb ls",
    async function createDB(name, options = {}) {
      const dbObj = await idb.setup({ storeName: name, ...options })

      /* =========================
         LOAD INITIAL DATA
      ========================== */
      const records = await idb.getAll(dbObj)
      const state = Object.create(null)
      const proxyCache = new WeakMap()

      function setByPath(obj, pathArray, value) {
        let current = obj
        for (let i = 0; i < pathArray.length - 1; i++) {
          const key = pathArray[i]
          if (!current[key] || typeof current[key] !== "object")
            current[key] = {}
          current = current[key]
        }
        const lastKey = pathArray[pathArray.length - 1]
        if (value === undefined) delete current[lastKey]
        else current[lastKey] = value
      }

      for (const { id, val } of records) {
        // id is stored as array
        setByPath(state, id, val)
      }

      /* =========================
         EVENT SYSTEM
      ========================== */
      const listeners = new Map()
      function on(event, cb) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(cb)
        return [event, cb]
      }
      function off([event, cb]) {
        listeners.get(event)?.delete(cb)
      }
      function emit(event, payload) {
        listeners.get(event)?.forEach((cb) => cb(payload))
      }

      /* =========================
         LEADER SYSTEM
      ========================== */
      const TAB_ID = crypto.randomUUID()
      const channel = new BroadcastChannel("indexeddb_ls_" + name)
      const tabs = new Map([[TAB_ID, Date.now()]])
      let leaderId = TAB_ID
      let isLeader = true
      const HEARTBEAT_INTERVAL = 1000
      const LEADER_TIMEOUT = 3000

      function electLeader() {
        const alive = [...tabs.entries()]
          .filter(([, t]) => Date.now() - t < LEADER_TIMEOUT)
          .map(([id]) => id)
          .sort()
        if (!alive.length) return
        const newLeader = alive[0]
        if (newLeader === leaderId) return
        const wasLeader = isLeader
        leaderId = newLeader
        isLeader = leaderId === TAB_ID
        if (!isLeader && wasLeader)
          emit("leader-stepped-down", {
            oldLeaderId: TAB_ID,
            newLeaderId: leaderId,
          })
        if (isLeader) emit("leader-elected", { leaderId })
      }

      function heartbeat() {
        channel.postMessage({ type: "heartbeat", id: TAB_ID })
      }

      channel.onmessage = (e) => {
        const msg = e.data
        const now = Date.now()
        switch (msg.type) {
          case "hello":
          case "heartbeat":
            tabs.set(msg.id, now)
            electLeader()
            break
          case "goodbye":
            tabs.delete(msg.id)
            electLeader()
            break
          case "write-request":
            if (isLeader) queueWrite(msg.key, msg.value)
            break
          case "external-update":
            applyExternal(msg.items)
            break
        }
      }

      channel.postMessage({ type: "hello", id: TAB_ID })
      setInterval(heartbeat, HEARTBEAT_INTERVAL)
      window.addEventListener("beforeunload", () => {
        channel.postMessage({ type: "goodbye", id: TAB_ID })
      })

      /* =========================
         BATCH WRITE ENGINE
      ========================== */
      const writeQueue = new Map()
      let flushScheduled = false
      let flushing = false
      let pendingResolves = []

      function scheduleFlush() {
        if (flushScheduled) return
        flushScheduled = true
        queueMicrotask(async () => {
          flushScheduled = false
          await flush()
        })
      }

      function queueWrite(pathArray, value) {
        if (!isLeader) {
          channel.postMessage({
            type: "write-request",
            key: pathArray,
            value,
          })
          return
        }
        writeQueue.set(pathArray, { id: pathArray, val: value })
        scheduleFlush()
      }

      async function flush() {
        if (flushing || !isLeader || !writeQueue.size) {
          resolvePending()
          return
        }
        flushing = true
        const items = [...writeQueue.values()]
        writeQueue.clear()

        try {
          await new Promise((resolve, reject) => {
            const tx = dbObj.db.transaction(
              dbObj.storeName,
              "readwrite",
            )
            const store = tx.objectStore(dbObj.storeName)
            for (const item of items) {
              if (item.val === undefined) store.delete(item.id)
              else store.put(item)
            }
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
          })

          channel.postMessage({ type: "external-update", items })
          emit("flush", items)
        } finally {
          flushing = false
          resolvePending()
          if (writeQueue.size) scheduleFlush()
        }
      }

      function resolvePending() {
        pendingResolves.forEach((r) => r())
        pendingResolves = []
      }

      function doneSaving() {
        return new Promise((resolve) => {
          if (!writeQueue.size && !flushing && !flushScheduled)
            resolve()
          else pendingResolves.push(resolve)
        })
      }

      function applyExternal(items) {
        for (const { id, val } of items) setByPath(state, id, val)
        emit("external-change", items)
        emit("change", { type: "external", items })
      }

      /* =========================
         REACTIVE PROXY
      ========================== */
      function isPlainObject(value) {
        if (value === null) return false
        if (Array.isArray(value)) return true // arrays are OK to proxy
        if (typeof value !== "object") return false // primitives (string, number, boolean) are returned as-is
        const proto = Object.getPrototypeOf(value)
        return proto === Object.prototype // only plain objects
      }
      function reactive(obj, basePath = []) {
        if (!isPlainObject(obj)) return obj // <-- don't proxy Blobs, FileHandles, etc.
        if (proxyCache.has(obj)) return proxyCache.get(obj)

        const proxy = new Proxy(obj, {
          get(target, prop) {
            return reactive(target[prop], [...basePath, prop])
          },
          set(target, prop, value) {
            target[prop] = value
            queueWrite([...basePath, prop], value)
            emit("change", { type: "set", path: [...basePath, prop] })
            return true
          },
          deleteProperty(target, prop) {
            delete target[prop]
            queueWrite([...basePath, prop], undefined)
            emit("change", {
              type: "delete",
              path: [...basePath, prop],
            })
            return true
          },
        })

        proxyCache.set(obj, proxy)
        return proxy
      }

      /* =========================
         MAIN PROXY HANDLER
      ========================== */
      const handler = {
        get(_, prop) {
          switch (prop) {
            case "on":
              return on
            case "off":
              return off
            case "doneSaving":
              return doneSaving()
            case "all":
              return state
            case "clear":
              return async () => {
                await idb.clearAll(dbObj)
                for (const key of Object.keys(state))
                  delete state[key]
                emit("clear", {})
                emit("change", { type: "clear" })
                return state
              }
            case "saveall":
              return async () => {
                for (const [k, v] of Object.entries(state))
                  queueWrite([k], v)
                await flush()
              }
            case Symbol.iterator:
              return function* () {
                for (const [id, val] of Object.entries(state))
                  yield { id, val }
              }
            default:
              return reactive(state[prop], [prop])
          }
        },
        set(_, prop, value) {
          state[prop] = value
          queueWrite([prop], value)
          emit("set", { key: prop, value })
          emit("change", { type: "set", key: prop, value })
          return true
        },
        deleteProperty(_, prop) {
          if (!(prop in state)) return true
          delete state[prop]
          queueWrite([prop], undefined)
          emit("delete", { key: prop })
          emit("change", { type: "delete", key: prop })
          return true
        },
        ownKeys() {
          return Reflect.ownKeys(state)
        },
        has(_, prop) {
          return prop in state
        },
        getOwnPropertyDescriptor(_, prop) {
          if (prop in state)
            return {
              configurable: true,
              enumerable: true,
              value: state[prop],
              writable: true,
            }
        },
      }

      return new Proxy(state, handler)
    },
  )
})()
