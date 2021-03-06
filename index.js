/**
 * The main entry of the application.
 */
require('./src/bootstrap')
const _ = require('lodash')
const Kafka = require('no-kafka')
const config = require('config')
const util = require('util')
const healthcheck = require('topcoder-healthcheck-dropin')
const m2mAuth = require('tc-core-library-js').auth.m2m
const logger = require('./src/common/logger')
const NewSubmissionService = require('./src/services/NewSubmissionService')
const IDGenerator = require('./src/services/IdGenerator')
const Informix = require('./src/services/Informix')

logger.info(`KAFKA URL - ${config.KAFKA_URL}`)

// db informix option
const dbOpts = {
  database: config.DB_NAME,
  username: config.DB_USERNAME,
  password: config.DB_PASSWORD,
  pool: {
    min: 0,
    max: 10
  }
}

const db = new Informix(dbOpts)
const m2m = ((config.AUTH0_CLIENT_ID && config.AUTH0_CLIENT_SECRET) ? m2mAuth(_.pick(config, ['AUTH0_URL', 'AUTH0_AUDIENCE', 'TOKEN_CACHE_TIME'])) : null)

/**
 * Handle the messages from Kafka.
 * @param {Array<Object>} messages the messages
 * @param {String} topic the topic
 * @param {Number} partition the partition
 * @private
 */
function handleMessages (messages, topic, partition) {
  return Promise.each(messages, (m) => {
    const messageValue = m.message.value ? m.message.value.toString('utf8') : null
    const messageInfo = `message from topic ${topic}, partition ${partition}, offset ${m.offset}: ${messageValue}`

    logger.debug(`Received ${messageInfo}`)

    // Handle the event
    return NewSubmissionService.handle(messageValue, db, m2m, idUploadGen, idSubmissionGen)
      .then(() => {
        logger.debug(`Completed handling ${messageInfo}`)

        // Commit offset
        return consumer.commitOffset({ topic, partition, offset: m.offset })
          .catch(err => {
            logger.error(`Failed to commit offset for ${messageInfo}: ${err.message}`)
            logger.error(util.inspect(err))
          })
      })
      .catch(err => {
        // Catch all errors thrown by the handler
        logger.error(`Failed to handle ${messageInfo}: ${err.message}`)
        logger.error(util.inspect(err))
      })
  })
}

// Initialize the consumer
const consumer = new Kafka.GroupConsumer({
  handlerConcurrency: 1,
  groupId: config.KAFKA_GROUP_ID,
  connectionString: config.KAFKA_URL,
  ssl: {
    cert: config.KAFKA_CLIENT_CERT,
    key: config.KAFKA_CLIENT_CERT_KEY
  }
})

const idUploadGen = new IDGenerator(db, config.ID_SEQ_UPLOAD)
const idSubmissionGen = new IDGenerator(db, config.ID_SEQ_SUBMISSION)

// check if there is kafka connection alive
function check () {
  if (!consumer.client.initialBrokers && !consumer.client.initialBrokers.length) {
    return false
  }
  let connected = true
  consumer.client.initialBrokers.forEach(conn => {
    logger.debug(`url ${conn.server()} - connected=${conn.connected}`)
    connected = conn.connected & connected
  })
  return connected
}

// Start to listen from the Kafka topic
consumer.init({
  subscriptions: [config.KAFKA_NEW_SUBMISSION_TOPIC, config.KAFKA_UPDATE_SUBMISSION_TOPIC],
  handler: handleMessages
})
  .then(() => {
    healthcheck.init([check])
  })
  .catch(err => {
    logger.error(util.inspect(err))
    process.exit(1)
  })
if (process.env.NODE_ENV === 'test') {
  module.exports = consumer
}
if (process.env.NODE_ENV === 'mock') {
  // start mock server if NODE_ENV = mock
  const { mockServer } = require('./test/mock-api')
  mockServer.listen(config.MOCK_SERVER_PORT)
  console.log(`mock api is listen port ${config.MOCK_SERVER_PORT}`)
}
