var x = loadlib("libloader")

const indexeddb_funcs = (() => {
  function openDB({ dbName, storeName, keyPath = "id" }) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)

      req.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath })
        }
      }

      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
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

  function tx(dbObj, mode) {
    return dbObj.db
      .transaction(dbObj.storeName, mode)
      .objectStore(dbObj.storeName)
  }

  function getall(dbObj) {
    return new Promise((res, rej) => {
      const r = tx(dbObj, "readonly").getAll()
      r.onsuccess = () => res(r.result || [])
      r.onerror = () => rej(r.error)
    })
  }

  return { setup, getall }
})()

x.savelib("indexeddb ls", async function newdbproxy(name, obj = {}) {
  /* =========================
     BASIC SETUP
  ========================== */
  const db = await indexeddb_funcs.setup({
    storeName: name,
    keyPath: "id",
    storePrefix: "",
    ...obj,
  })

  const initial = await indexeddb_funcs.getall(db)
  let localData = {}
  initial.forEach((i) => (localData[i.id] = i.val))

  /* =========================
     EVENTS
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
     LEADER ELECTION WITH HEARTBEAT
  ========================== */
  const TAB_ID = crypto.randomUUID()
  const channel = new BroadcastChannel("indexeddb_ls_" + name)

  const tabs = new Map([[TAB_ID, Date.now()]]) // track last seen timestamps
  let leaderId = TAB_ID
  let isLeader = true

  const HEARTBEAT_INTERVAL = 1000
  const LEADER_TIMEOUT = 3000

  function electLeader() {
    const aliveTabs = [...tabs.entries()].filter(
      ([id, lastSeen]) => Date.now() - lastSeen < LEADER_TIMEOUT,
    )
    if (!aliveTabs.length) return
    const newLeaderId = aliveTabs.map(([id]) => id).sort()[0]
    if (leaderId !== newLeaderId) {
      leaderId = newLeaderId
      const oldLeader = isLeader
      isLeader = leaderId === TAB_ID
      if (!isLeader && oldLeader)
        emit("leader-stepped-down", {
          oldLeaderId: TAB_ID,
          newLeaderId: leaderId,
        })
      if (isLeader) emit("leader-elected", { leaderId })
    }
  }

  function sendHeartbeat() {
    channel.postMessage({ type: "heartbeat", id: TAB_ID })
  }

  channel.onmessage = (e) => {
    const msg = e.data
    const now = Date.now()

    switch (msg.type) {
      case "hello":
        tabs.set(msg.id, now)
        electLeader()
        break
      case "goodbye":
        tabs.delete(msg.id)
        electLeader()
        break
      case "heartbeat":
        tabs.set(msg.id, now)
        electLeader() // leader may have died
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
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL)

  window.addEventListener("beforeunload", () => {
    channel.postMessage({ type: "goodbye", id: TAB_ID })
    tabs.delete(TAB_ID)
    electLeader()
  })

  /* =========================
     BATCH ENGINE (Leader Only)
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
    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_DELAY)
  }

  async function flush() {
    if (!isLeader || !writeQueue.size) {
      resolveDone()
      return
    }
    const items = [...writeQueue.values()]
    writeQueue.clear()
    clearTimeout(flushTimer)
    flushTimer = null

    await new Promise((res, rej) => {
      const txObj = db.db.transaction(db.storeName, "readwrite")
      const store = txObj.objectStore(db.storeName)
      items.forEach((i) => store.put(i))
      txObj.oncomplete = res
      txObj.onerror = () => rej(txObj.error)
    })

    channel.postMessage({ type: "external-update", items })
    emit("flush", items)
    resolveDone()
  }

  function resolveDone() {
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
    items.forEach((i) => (localData[i.id] = i.val))
    emit("external-change", items)
    emit("change", { type: "external", items })
  }

  /* =========================
     CORE SET / REMOVE
  ========================== */
  function setProp(prop, val) {
    localData[prop] = val
    queueWrite(prop, val)
    emit("set", { key: prop, value: val })
    emit("change", { type: "set", key: prop, value: val })
  }

  function deleteProp(prop) {
    const existed = prop in localData
    delete localData[prop]

    if (isLeader) {
      const txObj = db.db.transaction(db.storeName, "readwrite")
      txObj.objectStore(db.storeName).delete(prop)
    } else {
      channel.postMessage({
        type: "write-request",
        key: prop,
        value: undefined,
      })
    }

    if (existed) {
      emit("delete", { key: prop })
      emit("change", { type: "delete", key: prop })
    }
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
      deleteProp(prop)
      return true
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
        case "saveall":
          return async function () {
            Object.entries(localData).forEach(([k, v]) =>
              queueWrite(k, v),
            )
            await flush()
          }
        case Symbol.iterator:
          return function* () {
            for (const [id, val] of Object.entries(localData))
              yield { id, val }
          }
        default:
          return Reflect.get(target, prop)
      }
    },
  }

  return new Proxy(localData, handler)
})
