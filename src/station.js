'use strict'
module.exports.stations = stations;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const bunyan = NodePackage.bunyan;
const recipe = require('./recipe');
const order = require('./order');
const checkin = require('./checkin');
const checkout = require('./checkout');
const parameters = require('./parameters');
const plcserverconnection = require('./plcserverconnection');
const subassemblycheck = require('./subassemblycheck');
const componentcheck = require('./componentcheck');
const imagesave = require('./imagesave');
const virtualmainid = require('./virtualmainid');
const autorecipeupgrade = require('./autorecipeupgrade');
const manualrecipeupgrade = require('./manualrecipeupgrade');
const inspect = require('./inspect');
const ngoffline = require('./ngoffline');
const stationstatus = require('./stationstatus');
const reworkcheck = require('./reworkcheck');
function stations(config, substation, utility, tags, MESSAGESCODE, emitter, businessHours, businessHolidays) {
    const stationTags = tags.substationtags;
    const staticTags = tags.statictags;
    let lineid = substation[stationTags.LINEID_TAG];
    let sublineid = substation[stationTags.SUBLINEID_TAG];
    let substationname = substation[stationTags.NAME_TAG];
    let substationid = substation[stationTags.SUBSTATIONID_TAG];
    const kafkaConfigEdge = config.kafkaEdge;
    const log = bunyan.createLogger({ name: substationid, level: config.logger.loglevel });
    // topic name for kafka is combination of `${substationid}` for uniqueness
    let topic_name = `${substationid}`;
    // get the parameters
    const PARAMETERS = parameters.parameters(config, substation, utility, tags, MESSAGESCODE, emitter);
    PARAMETERS.initEmitter();
    PARAMETERS.getParameters();

    const ORDER = order.order(config, substation, utility, tags, MESSAGESCODE, emitter);
    ORDER.initEmitter();
    // get running order on startup of Event Analyzer
    ORDER.getOrder();

    const RECIPE = recipe.recipe(config, substation, ORDER, utility, tags, MESSAGESCODE, emitter);
    RECIPE.initEmitter();

    const VIRTUALMAINID = virtualmainid.virtualmainid(config, substation, utility, tags, MESSAGESCODE)

    const CHECKIN = checkin.checkin(config, substation, PARAMETERS, ORDER, VIRTUALMAINID, utility, tags, MESSAGESCODE, emitter);
    CHECKIN.getCheckinSchema();

    const CHECKOUT = checkout.checkout(config, substation, PARAMETERS, ORDER, VIRTUALMAINID, utility, tags, MESSAGESCODE, emitter);
    CHECKOUT.getCheckoutSchema();
    CHECKOUT.getPartStatusSchema();
    CHECKOUT.getReworkSchema();

    const SUBASSEMBLYCHECK = subassemblycheck.subAssemblyCheck(config, substation, PARAMETERS, ORDER, utility, tags, MESSAGESCODE, emitter);

    const COMPONENTCHECK = componentcheck.componentcheck(config, substation, PARAMETERS, ORDER, utility, tags, MESSAGESCODE, emitter);
    COMPONENTCHECK.getComponentCheckSchema();

    const PLCSERVERCONNECTION = plcserverconnection.PLCServerConnection(config, substation, utility, tags, MESSAGESCODE);

    const IMAGESAVE = imagesave.imageSave(config, substation, utility, tags, MESSAGESCODE, emitter);

    const AUTORECIPEUPGRADE = autorecipeupgrade.autorecipeupgrade(config, substation, PARAMETERS, ORDER, utility, tags, MESSAGESCODE);

    const MANUALRECIPEUPGRADE = manualrecipeupgrade.manualrecipeupgrade(config, substation, PARAMETERS, ORDER, utility, tags, MESSAGESCODE);

    const INSPECT = inspect.inspect(config, substation, ORDER, utility, tags, MESSAGESCODE, emitter);
    INSPECT.initEmitter();

    const NGOFFLINE = ngoffline.ngoffline(config, substation, ORDER, utility, tags, MESSAGESCODE);

    const REWORKCHECK = reworkcheck.reworkcheck(config, substation, ORDER, utility, tags, MESSAGESCODE);

    const STATIONSTATUS = stationstatus.stationstatus(config, substation, PARAMETERS, ORDER, utility, tags, businessHours, businessHolidays);
    STATIONSTATUS.getStationStatusSchema();
    return {
        substationid: substationid,
        substationname: substationname,
        /**
         * This method update the substation information when update event triggered
         * @param {Object} stationinfo
         */
        updateStation(stationinfo) {
            substation = stationinfo;
            lineid = substation[stationTags.LINEID_TAG];
            sublineid = substation[stationTags.SUBLINEID_TAG];
            substationname = substation[stationTags.NAME_TAG];
            substationid = substation[stationTags.SUBSTATIONID_TAG];
            this.substationid = substationid;
            this.substationname = substationname;
            CHECKOUT.updateStation(stationinfo);
            CHECKIN.updateStation(stationinfo);
            SUBASSEMBLYCHECK.updateStation(stationinfo);
            COMPONENTCHECK.updateStation(stationinfo);
            STATIONSTATUS.updateStation(stationinfo);
            // when substation update some times combinations of lineid, sublineid, substationid changed
            // So we need to stop the kafka consumer and reconnect it again
            RECIPE.updateStationInfomraton(stationinfo);
            PLCSERVERCONNECTION.updateStationInfomraton(stationinfo);
        },
        initializeKafka() {
            // initialize Edge Kafka consumer
            this.connectToKafkaConsumer();
        },
        /**
         * Edge event kafka consumer initialization
         */
        connectToKafkaConsumer() {
            // TODO Code Review from Ankur for fetching latest offset message
            try {

                const kafka = NodePackage.kafkaNode;
                log.info('initializing Edge kafka connection');
                const client = new kafka.KafkaClient({ kafkaHost: `${kafkaConfigEdge.host}:${kafkaConfigEdge.port}` });
                let offset = new kafka.Offset(client);
                let latest = 1;
                let consumerGroup = null;
                offset.fetchLatestOffsets([topic_name], (err, offsets) => {
                    if (err) {
                        log.error(`error fetching latest offsets from kafka topic`);
                        log.error(`${err}`);
                        return;
                    }
                    Object.keys(offsets[topic_name]).forEach(o => {
                        latest = offsets[topic_name][o] > latest ? offsets[topic_name][o] : latest
                    })
                });
                consumerGroup = new kafka.ConsumerGroup(
                    {
                        kafkaHost: `${kafkaConfigEdge.host}:${kafkaConfigEdge.port}`,
                        groupId: 'traceablity-' + topic_name,
                        sessionTimeout: 15000,
                        protocol: ["roundrobin"],
                        encoding: 'utf8',
                        fromOffset: kafkaConfigEdge.fromOffset,
                        outOfRangeOffset: kafkaConfigEdge.outOfRangeOffset,
                        autoCommit: kafkaConfigEdge.autoCommit,
                        autoCommitIntervalMs: kafkaConfigEdge.autoCommitIntervalMs,
                        heartbeatInterval: 100,
                        maxTickMessages: 1,
                    },
                    topic_name
                );
                consumerGroup.on("connect", () => {
                    log.info("kafka consumerGroup connect");
                });
                consumerGroup.on('offsetOutOfRange', (err) => {
                    log.error(`offsetOutOfRange ${err}`);
                    consumerGroup.close(true, (err, res) => {
                        if (!err) {
                            log.error(`kafka event consumer connection closed successfully ${res}`);
                        } else {
                            log.error(`Error in closing kafka event consumer ${err}`);
                        }
                        this.connectToKafkaConsumer();
                    })
                })
                consumerGroup.on("error", (error) => {
                    log.error(`Error in kafka consumer: ${error}`);
                    consumerGroup.close(true, (err, res) => {
                        if (!err) {
                            log.error(`kafka event consumer connection closed successfully ${res}`);
                        } else {
                            log.error(`Error in closing kafka event consumer ${err}`);
                        }
                        this.connectToKafkaConsumer();
                    })
                });
                consumerGroup.on(`message`, async (message) => {
                    const payload = JSON.parse(message.value);
                    delete payload.ignore;
                    // log.info(message.offset + " = " + latest);
                    // wait for consuming messages till latestone
                    if (config.defaults.isPreviousDataIgnored) {
                        if (message.offset >= latest - 1) {
                            this.processStationData(payload);
                        }
                    } else {
                        this.processStationData(payload);
                    }

                });
            } catch (ex) {
                log.error(`Exception in connectToKafkaConsumer ${ex}`);
                this.connectToKafkaConsumer();
            }
        },
        /**
         * This method process the plc event consumed by the consumer
         * @param {Object} data
         */
        processStationData(data) {
            // TODO
            // combine data if timestamp less than 60 ms between 2 records
            /*
                if(!combinedData) {
                    combinedData = data
                }
                if(data.timestamp - combinedData.timestamp < 60) {
                    combinedData = {...combinedData, ...data};
                }
            */
            try {
                // recipe method
                RECIPE.processStationRecipe(data);
                // Bug RA-I378 Server and PLC online
                // TODO temp fix
                if (substation[stationTags.ISSERVERLIVE]) {
                    PLCSERVERCONNECTION.checkPLCServerConnection(data);
                }
                // Bug  RA-I341
                if (data[staticTags.PLCONLINE_TAG]) {
                    let updateProductValue = JSON.parse(substation.jsondata) || {};
                    if (updateProductValue[stationTags.UPDATEPRODUCT]) {
                        // order
                        ORDER.processStationData(data);
                    }
                    // check in
                    CHECKIN.processStationData(data);
                    // check out
                    CHECKOUT.processStationData(data);
                    // Sub Assembly check
                    SUBASSEMBLYCHECK.processStationData(data);
                    // Component check
                    COMPONENTCHECK.processStationData(data);
                    // save image
                    let imageLogicValue = JSON.parse(substation.jsondata) || {};
                    if (imageLogicValue[stationTags.ISIMAGESAVE_TAG]) {
                        IMAGESAVE.processStationData(data);
                    }
                    AUTORECIPEUPGRADE.processStationData(data);
                    MANUALRECIPEUPGRADE.processStationData(data);
                    INSPECT.processStationData(data);
                    NGOFFLINE.processStationData(data);
                    STATIONSTATUS.processStationData(data);
                    REWORKCHECK.processStationData(data);
                } else {
                    // do not process when plc live is false
                }
            } catch (ex) {
                debugger;

                log.error(`Exception in processStationData ${ex}`);
            }
        }
    }
}
