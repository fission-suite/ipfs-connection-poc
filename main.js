import { create } from 'ipfs-core'
import Websockets from 'libp2p-websockets'
import filters from 'libp2p-websockets/src/filters'


/** 🎛️ Connection interval knobs
 *
 * KEEP_ALIVE_INTERVAL: Interval to keep the connection alive when online
 * BACKOFF_INIT: Starting intervals for fibonacci backoff used when establishing a connection
 * KEEP_TRYING_INTERVAL: Interval to keep trying the connection when offline
 * 
 */

const KEEP_ALIVE_INTERVAL =
  1 * 60 * 1000 // 1 minute

const BACKOFF_INIT = {
  retryNumber: 0,
  lastBackoff: 0,
  currentBackoff: 1000
}

const KEEP_TRYING_INTERVAL =
  5 * 60 * 1000 // 5 minutes


// IPFS OPTIONS

const transportKey = Websockets.prototype[Symbol.toStringTag]

const OPTIONS = {
  config: {
    Addresses: {
      Delegates: []
    },
    Bootstrap: [],
    Discovery: {
      webRTCStar: { enabled: false }
    }
  },
  preload: {
    enabled: false
  },
  libp2p: {
    config: {
      peerDiscovery: { autoDial: false },
      transport: {
        [transportKey]: {
          // Allow /ws/ peers for local testing
          filter: filters.all
        }
      }
    }
  }
}

let peers = Promise.resolve(
  []
)
let peerConnections = []
let latestPeerTimeoutIds = {}


const main = async () => {
  // Local peers
  peers = [
    // run `npm run ipfs` to determine local peers
  ]

  // Production peers
  // peers = await fetchPeers();

  if (peers.length === 0) {
    throw new Error("💥 Couldn't start IPFS node, peer list is empty")
  };

  // Initialize peer reconnect timeoutIds
  peers.forEach(peer => {
    latestPeerTimeoutIds[peer] = null
  })

  const ipfs = await create(OPTIONS)
  self.ipfs = ipfs

  peers.forEach(peer => {
    tryConnecting(peer)
  })
}

// Try connecting when network comes online
self.addEventListener('online', () => {
  peers
    .filter(peer =>
      !peer.includes("/localhost/") &&
      !peer.includes("/127.0.0.1/") &&
      !peer.includes("/0.0.0.0/")
    )
    .forEach(peer => {
      tryConnecting(peer)
    })
})


// PEER LIST

function fetchPeers() {
  const peersUrl = "https://runfission.com/ipfs/peers"

  return fetch(peersUrl)
    .then(r => r.json())
    .then(r => r.filter(p => p.includes("/wss/")))
    .catch(e => { throw new Error("💥 Couldn't start IPFS node, failed to fetch peer list") })
}


// CONNECTION

async function keepAlive(peer, backoff, status) {
  log('retry number', backoff.retryNumber)
  log('currentBackoff', backoff.currentBackoff)

  let timeoutId = null;

  if (backoff.currentBackoff < KEEP_TRYING_INTERVAL) {
    log('backoff timeout', backoff.currentBackoff)

    // Start race between reconnect and ping
    timeoutId = setTimeout(() => reconnect(peer, backoff, status), backoff.currentBackoff)
  } else {
    log('at retry ceiling, keep trying')

    // Disregard backoff, but keep trying
    timeoutId = setTimeout(() => reconnect(peer, backoff, status), KEEP_TRYING_INTERVAL)
  }

  // Track the latest reconnect attempt
  latestPeerTimeoutIds[peer] = timeoutId

  self.ipfs.libp2p.ping(peer).then(latency => {
    log('alive')

    const updatedStatus = { connected: true, lastConnectedAt: Date.now(), latency }
    report(peer, updatedStatus)

    // Cancel reconnect because ping won
    clearTimeout(timeoutId)

    // Keep alive after the latest ping-reconnect race, ignore the rest
    if (timeoutId === latestPeerTimeoutIds[peer]) {
      setTimeout(() => keepAlive(peer, BACKOFF_INIT, updatedStatus), KEEP_ALIVE_INTERVAL)
    }
  }).catch(() => { })

}

async function reconnect(peer, backoff, status) {
  log('reconnecting')

  const updatedStatus = { ...status, connected: false, latency: null }
  report(peer, updatedStatus)

  try {
    await self.ipfs.swarm.disconnect(peer)
    await self.ipfs.swarm.connect(peer)
  } catch {
    // No action needed, we will retry
  }

  if (backoff.currentBackoff < KEEP_TRYING_INTERVAL) {
    const nextBackoff = {
      retryNumber: backoff.retryNumber + 1,
      lastBackoff: backoff.currentBackoff,
      currentBackoff: backoff.lastBackoff + backoff.currentBackoff
    }

    keepAlive(peer, nextBackoff, updatedStatus)
  } else {
    keepAlive(peer, backoff, updatedStatus)
  }
}

async function tryConnecting(peer) {
  self
    .ipfs.libp2p.ping(peer)
    .then(latency => {

      return ipfs.swarm
        .connect(peer, 1 * 1000)
        .then(() => {
          console.log(`🪐 Connected to ${peer}`)

          const status = { connected: true, lastConnectedAt: Date.now(), latency }
          report(peer, status)

          // Ensure permanent connection to Fission gateway
          // TODO: This is a temporary solution while we wait for
          //       https://github.com/libp2p/js-libp2p/issues/744
          //       (see "Keep alive" bit)
          setTimeout(() => keepAlive(peer, BACKOFF_INIT, status), KEEP_ALIVE_INTERVAL)
        })
    })
    .catch(() => {
      console.log(`🪓 Could not connect to ${peer}. Will keep trying.`)

      const status = { connected: false, lastConnectedAt: 0, latency: null }
      report(peer, status)

      keepAlive(peer, BACKOFF_INIT, status)
    })
}


// REPORTING

function report(peer, status) {
  peerConnections = peerConnections
    .filter(connection => connection.peer !== peer)
    .concat({ peer, ...status })

  const offline = peerConnections.every(connection => !connection.connected)
  const lastConnectedAt = peerConnections.reduce((newest, connection) =>
    newest >= connection.lastConnectedAt ? newest : connection.lastConnectedAt,
    0
  )

  const activeConnections = peerConnections.filter(connection => connection.latency !== null)
  const averageLatency = activeConnections.length > 0
    ? peerConnections.reduce((sum, connection) => sum + connection.latency, 0) / activeConnections.length
    : null

  console.table(peerConnections)
  console.log('offline', offline)
  console.log('last connected at', lastConnectedAt === 0 ? null : lastConnectedAt)
  console.log('average latency', averageLatency)
}


// START

const start = document.getElementById('start')

start.addEventListener('click', () => {
  main();
})


// LOGGING

let { DEBUG } = process.env

const log = (message, val) => {
  if (DEBUG === 'true') {
    if (val !== undefined) {
      console.log(message, val)
    } else {
      console.log(message)
    }
  }
}