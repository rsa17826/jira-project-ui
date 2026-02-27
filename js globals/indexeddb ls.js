// ==UserScript==
// @name         lib:indexeddb ls
// @version      13
// @description  none
// @license      GPLv3
// @run-at       document-start
// @author       rssaromeo
// @match        *://*/*
// @include      *
// @tag          lib
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
            db.createObjectStore(storeName, { keyPath })
          }
        }

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }

    async function setup({
      storeName,
      keyPath = "id",
      storePrefix = "",
    }) {
      const dbName =
        storePrefix ? `${storePrefix}_${storeName}` : storeName

      const db = await openDB({ dbName, storeName, keyPath })
      return { db, storeName }
    }

    function getStore(dbObj, mode = "readonly") {
      const tx = dbObj.db.transaction(dbObj.storeName, mode)
      return tx.objectStore(dbObj.storeName)
    }

    function getAll(dbObj) {
      return new Promise((resolve, reject) => {
        const request = getStore(dbObj).getAll()
        request.onsuccess = () => resolve(request.result || [])
        request.onerror = () => reject(request.error)
      })
    }

    function clearAll(dbObj) {
      return new Promise((resolve, reject) => {
        const request = getStore(dbObj, "readwrite").clear()
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
      const dbObj = await idb.setup({
        storeName: name,
        keyPath: "id",
        storePrefix: "",
        ...options,
      })

      /* =========================
       LOAD INITIAL DATA
    ========================== */

      const records = await idb.getAll(dbObj)
      let localData = {}

      for (const { id, val } of records) {
        localData[id] = val
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
       TAB LEADER SYSTEM
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

        if (!isLeader && wasLeader) {
          emit("leader-stepped-down", {
            oldLeaderId: TAB_ID,
            newLeaderId: leaderId,
          })
        }

        if (isLeader) {
          emit("leader-elected", { leaderId })
        }
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
      let flushTimer = null
      let pendingResolves = []
      const BATCH_DELAY = 10

      function queueWrite(key, value) {
        if (!isLeader) {
          channel.postMessage({ type: "write-request", key, value })
          return
        }

        writeQueue.set(key, { id: key, val: value })

        if (!flushTimer) {
          flushTimer = setTimeout(flush, BATCH_DELAY)
        }
      }

      async function flush() {
        if (!isLeader || !writeQueue.size) {
          resolvePending()
          return
        }

        const items = [...writeQueue.values()]
        writeQueue.clear()

        clearTimeout(flushTimer)
        flushTimer = null

        await new Promise((resolve, reject) => {
          const tx = dbObj.db.transaction(
            dbObj.storeName,
            "readwrite",
          )
          const store = tx.objectStore(dbObj.storeName)

          for (const item of items) {
            if (item.val === undefined) {
              store.delete(item.id)
            } else {
              store.put(item)
            }
          }

          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        })

        channel.postMessage({ type: "external-update", items })

        emit("flush", items)
        resolvePending()
      }

      function resolvePending() {
        pendingResolves.forEach((r) => r())
        pendingResolves = []
      }

      function doneSaving() {
        return new Promise((resolve) => {
          if (!writeQueue.size && !flushTimer) resolve()
          else pendingResolves.push(resolve)
        })
      }

      function applyExternal(items) {
        for (const { id, val } of items) {
          if (val === undefined) delete localData[id]
          else localData[id] = val
        }

        emit("external-change", items)
        emit("change", { type: "external", items })
      }

      /* =========================
       CORE OPERATIONS
    ========================== */

      function setProp(key, value) {
        localData[key] = value
        queueWrite(key, value)

        emit("set", { key, value })
        emit("change", { type: "set", key, value })
      }

      function deleteProp(key) {
        if (!(key in localData)) return true

        delete localData[key]
        queueWrite(key, undefined)

        emit("delete", { key })
        emit("change", { type: "delete", key })

        return true
      }

      /* =========================
       PROXY
    ========================== */

      const handler = {
        set(target, prop, value) {
          target[prop] = value
          setProp(prop, value)
          return true
        },

        deleteProperty(target, prop) {
          return deleteProp(prop)
        },

        get(target, prop) {
          switch (prop) {
            case "on":
              return on
            case "off":
              return off
            case "doneSaving":
              return doneSaving()
            case "all":
              return localData

            case "clear":
              return async () => {
                await idb.clearAll(dbObj)

                // ✅ Properly clear existing proxy target
                for (const key of Object.keys(localData)) {
                  delete localData[key]
                }

                emit("clear", {})
                emit("change", { type: "clear" })

                return localData
              }
            case "saveall":
              return async () => {
                for (const [k, v] of Object.entries(localData)) {
                  queueWrite(k, v)
                }
                await flush()
              }

            case Symbol.iterator:
              return function* () {
                for (const [id, val] of Object.entries(localData)) {
                  yield { id, val }
                }
              }

            default:
              return Reflect.get(target, prop)
          }
        },
      }

      return new Proxy(localData, handler)
    },
  )
})()
