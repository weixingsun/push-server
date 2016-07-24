
const crypto = require('crypto')
const express = require('express')
const jsonParser = require('body-parser').json()
const request = require('superagent')
const level = require('level')
const subdown = require('subleveldown')
const parallel = require('run-parallel')
const debug = require('debug')('tradle:push-server')
const nkeyEC = require('nkey-ec')
const tradle = require('@tradle/engine')
const createValidator = tradle.validator
const protocol = tradle.protocol
// const protocol = require('@tradle/protocol')
const DEFAULT_LANG = 'en'
const DEFAULT_PUSHD_URL = 'http://127.0.0.1:24432'
// pushd supports others, but limit for now
const PROTOCOLS = ['apns', 'gcm']

module.exports = function (opts) {
  const app = express()
  const dbOpts = { valueEncoding: 'json' }
  const db = level(opts.db, dbOpts)
  const subscribers = subdown(db, 'subscribers', dbOpts)
  const unconfirmedPublishers = subdown(db, 'waitingRoom', dbOpts)
  const publishers = subdown(db, 'publishers', dbOpts)
  const pushdBaseUrl = opts.pushd || DEFAULT_PUSHD_URL
  const server = app.listen(opts.port)
  const defaultLang = opts.lang || DEFAULT_LANG
  const validator = createValidator()

  app.post('/subscriber', jsonParser, function register (req, res) {
    const body = req.body
    const identity = body.identity
    try {
      validate(identity, identity)
    } catch (err) {
      return res.status(400).send('invalid identity')
    }

    try {
      validate(body, identity)
    } catch (err) {
      return res.status(400).send('invalid request')
    }

    const proto = body.protocol
    // TODO: verify
    if (PROTOCOLS.indexOf(proto) === -1) {
      return res.status(400).send(`unsupported protocol: ${proto}`)
    }

    if (!body.token) {
      return res.status(400).send('expected "token"')
    }

    const link = protocol.linkString(identity)
    request.post(pushdBaseUrl + '/subscribers')
      .type('form') // send url-encoded
      .send({
        proto: proto,
        token: body.token,
        lang: body.lang,
        category: body.category,
        contentAvailable: !!body.contentAvailable,
        badge: body.badge
      })
      .end(function (err, pushdRes) {
        if (err) return oops(err, res)

        if (pushdRes.status === 400) {
          return res.status(400).send('Invalid token or protocol')
        }

        if (pushdRes.status === 200) {
          return res.status(200).end()
        }

        const body = pushdRes.body
        // pushd readme example response:
        // {
        //     "proto":"apns",
        //     "token":"fe66489f304dc75b8d6e8200dff8a456e8daeacec428b427e9518741c92c6660",
        //     "lang":"fr",
        //     "badge":0,
        //     "updated":1332953375,
        //     "created":1332953375,
        //     "id":"J8lHY4X1XkU"
        // }

        const id = body.id
        subscribers.put(link, {
          id: id,
          identity: identity
        }, function (err) {
          if (err) return oops(err, res)

          debug('registered: ' + link)
          res.status(200).end()
        })
      })
  })

  app.post('/subscription', jsonParser, function (req, res) {
    const body = req.body
    const publisher = body.publisher
    const subscriber = body.subscriber
    subscribers.get(subscriber, function (err, info) {
      if (err) return res.status(404).end()

      try {
        validate(body, info.identity)
      } catch (err) {
        return res.status(401).send('invalid signature')
      }

      const id = info.id
      const event = privateEventName(id, publisher)
      request.post(`${pushdBaseUrl}/subscriber/${id}/subscriptions/${event}`)
        .end(function (err, subscribeRes) {
          if (err) return oops(err, res)

          res.status(200).end()
        })
    })
  })

  /**
   * This method is probably going away
   * {
   *   from: '..link..',
   *   to: '..link..',
   *   body: {
   *     msg: 'hey ho',
   *     sound: 'ping.aiff',
   *     'data.customFieldA': 'oh no',
   *     'data.customFieldB': 'oh yes',
   *     ...
   *   }
   * }
   */
  // app.post('/event/:subscriber/:publisher', jsonParser, authenticate, function (req, res) {
  //   const body = req.body
  //   const subscriber = req.params.subscriber
  //   const publisher = req.params.publisher
  //   // TODO: authentication

  //   // if (!body.event) {
  //   //   return res.status(400).send('expected "event"')
  //   // }

  //   // TODO:
  //   //   validate eventBody
  //   //   set size limit on eventBody
  //   parallel([
  //     taskCB => subscribers.get(subscriber, taskCB),
  //     taskCB => publishers.get(publisher, taskCB)
  //   ], function (err, results) {
  //     if (err) return res.status(404).end()

  //     const id = results[0]
  //     const event = privateEventName(id, publisher)
  //     request.post(`${pushdBaseUrl}/event/${event}`)
  //       .type('form') // send url-encoded
  //       .send(req.body)
  //       .end(function (err, subscribeRes) {
  //         if (err) return oops(err, res)

  //         res.status(200).end()
  //       })
  //   })
  // })

  app.post('/notification/:subscriber/:publisher', authenticate, function (req, res) {
    const subscriber = req.params.subscriber
    const publisher = req.params.publisher
    parallel([
      taskCB => subscribers.get(subscriber, taskCB),
      taskCB => publishers.get(publisher, taskCB)
    ], function (err, results) {
      // 404 leaks some information
      // maybe this call should always return 200
      if (err) return res.status(404).end()

      const id = results[0].id
      const event = privateEventName(id, publisher)
      // const body = req.body
      // body.contentAvailable = true
      request.post(`${pushdBaseUrl}/event/${event}`)
        .type('form') // send url-encoded
        .send({
          contentAvailable: true,
          sound: '',
          msg: ''
        })
        .end(function (err, subscribeRes) {
          if (err) return oops(err, res)

          res.status(200).end()
        })
    })
  })

  app.post('/publisher', jsonParser, function (req, res) {
    if (req.body.key) return registerPublisher(req, res)
    else return confirmPublisher(req, res)
  })

  function registerPublisher (req, res) {
    const body = req.body
    const identity = body.identity
    // TODO: validate link
    const key = body.key
    const nonce = crypto.randomBytes(32).toString('base64')
    try {
      validate(identity, identity)
    } catch (err) {
      return res.status(400).send('invalid identity')
    }

    const link = protocol.linkString(identity)
    const regInfo = {
      link: link,
      key: {
        pub: key.pub,
        curve: key.curve
      }
    }

    unconfirmedPublishers.put(nonce, regInfo, function (err) {
      if (err) return oops(err, res)

      res.status(200).send(nonce)
    })
  }

  function confirmPublisher (req, res) {
    const body = req.body
    // TODO: validate sig
    const nonce = body.nonce
    const salt = body.salt
    const sig = body.sig
    if (!(nonce && salt && sig)) {
      return res.status(400).send('expected "nonce", "salt", "sig"')
    }

    unconfirmedPublishers.get(nonce, function (err, regInfo) {
      if (err) return res.status(404).end()

      const key = nkeyEC.fromJSON(regInfo.key)
      key.verify(sha256(nonce + salt), sig, function (err, verified) {
        if (err) return oops(err, res)
        if (!verified) return res.status(401).send('invalid signature')

        publishers.put(regInfo.link, {}, function (err) {
          if (err) return oops(err, res)

          unconfirmedPublishers.del(nonce, function (err) {
            if (err) return debug('failed to confirm publisher', err)
          })

          res.status(200).end()
        })
      })
    })
  }

  app.use(defaultErrHandler)

  return server.close.bind(server)

  function authenticate (req, res, next) {
    const params = req.params
    const subscriber = params.subscriber
    const publisher = params.publisher
    const sig = req.body && req.body.sig
    // TODO: check sig

    next()
  }

  function defaultErrHandler (err, req, res, next) {
    oops(err, res)
  }

  function validate (object, authorIdentity) {
    validator.checkAuthentic({
      object,
      author: { object: authorIdentity }
    })
  }
}

function privateEventName (subscriberID, publisherLink) {
  return subscriberID + '-' + publisherLink
}

function oops (err, res) {
  console.error(err.stack)
  return res.status(500).send('oops, something went wrong. Please try again later')
}

// function assert (statement, errMsg) {
//   if (!statement) throw new Error(errMsg || 'assertion failed')
// }

// function pick (obj /* prop1, prop2 */) {
//   const props = {}
//   for (var i = 1; i < arguments.length; i++) {
//     const prop = arguments[i]
//     props[prop] = obj[prop]
//   }

//   return props
// }

function sha256 (data) {
  return crypto.createHash('sha256').update(data).digest('base64')
}