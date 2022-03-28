module.exports.kafkaProducer = kafkaProducer;

const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const bunyan = NodePackage.bunyan;
const kafka = NodePackage.kafkaNode;
function kafkaProducer (config, utility){
    const kafkaConfig = config.kafkaEdge;
    const loglevel = config.logger && config.logger.loglevel ? (config.logger.loglevel || 20) : 30    
    const log = bunyan.createLogger({ name: 'kafkaproducer', level: loglevel});
    const Producer = kafka.Producer;
    let client;    
    let producer;
    let fixedString = '';
    for(var i = 0; i < kafkaConfig.insertMaxBytes; i++){
        fixedString += '-';
    }
    return {
        /**
         * This method check the kafka connection is ready or not
         */
        init: function(){
            log.error(`connecting to kafka...`);
            client = new kafka.KafkaClient({kafkaHost: `${kafkaConfig.host}:${kafkaConfig.port}`});   
            producer = new Producer(client);
            producer.on(`ready`, () => {
                log.error(`Producer Ready`);
            });
            producer.on(`error`, (err) => {
                log.error(`[kafka-producer]: connection errored`);
            })
            client.on('error', (err) => {
                log.error('client error: ' + err);
                this.init();
            }) 
        },
        /**
         * This method send the payload to kafka topic
         * @param {String} topic_name 
         * @param {Object} data 
         */
        sendMessage: function(topic_name, plcdata) {
            // check kafka producer is ready or not and then send message to kafka topic
            try {
                const data = utility.cloneDeep(plcdata);
                if(producer && producer.ready) {
                    // add substring in data for fix of byte in kafka
                    data.ignore = this.appendChar(data);                    
                    const payload = [{
                        topic: topic_name,
                        messages: JSON.stringify(data)
                    }];
                    producer.send(payload, (err, data) => {
                        if (err) {
                            log.error(`Producer Error sending data for ${topic_name} ${err}`);
                        } else {          
                            log.info(`[kafka-producer -> ${topic_name}] size : ${JSON.stringify(payload).length}, payload : ${JSON.stringify(payload)} broker update success`)
                        }
                    });
                } else {
                    log.error(`Kafka Producer is not ready. Please check kafka is configuration and kafka is running or not`);
                }
            } catch(ex) {
                log.error(`exeption in writing data to kafka topic ${ex}`);
            } 
        },
        /**
         * This method close kafka coneection
         */
        closeKafkaConnection(callback) {
            producer.close(callback);
        },
        /**
         * This method append the empty characters to kafka payload
         * @param {Object} data 
         */
        appendChar: function(data){
            try {
                const lengthOfStr = JSON.stringify(data).length;
                // 12 length for tagname "ignore":
                const subString = fixedString.substring(lengthOfStr + 12, fixedString.length);
                return subString;
            } catch(ex) {
                log.error(`Exception in checking length of object ${ex}`);
            }
        }
    }
}