'use strict'
let CONFIG, configfilename = process.argv[2];
try {
    if (!configfilename) {
        console.log(`Error please pass correct argument of config file name`);
        process.exit(1);
    }
    let configfilepath = `./config/${configfilename}`;
    CONFIG = require(configfilepath);
} catch (ex) {
    console.log(`Exception in reading config file ${ex}`);
    process.exit(1);
}
const TAGS = require('./tags/tags');
const MESSAGESCODE = require('./messages/log');
const nodePackage = require('./service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
NodePackage.server = CONFIG.server;
NodePackage.messerver = CONFIG.messerver;
NodePackage.socketio = CONFIG.socketio;
const bunyan = NodePackage.bunyan;
const UTILITY = require('./utils/utility');
UTILITY.validateConfigfileParameters(CONFIG);
const SOCKETLISTENER = require('./utils/socketlistener');
SOCKETLISTENER.socketlistener(CONFIG).init();
const emitter = SOCKETLISTENER.emitter;
const authJS = require('./utils/auth');
const auth = authJS.auth(CONFIG, UTILITY, MESSAGESCODE, emitter);
UTILITY.setAuthInstance(auth);
const activesessionJS = require('./utils/activesession');
const activesession = activesessionJS.activesession(CONFIG, UTILITY, MESSAGESCODE, emitter);
const businessHoursJS = require('./utils/businesshours');
const businessHours = businessHoursJS.businessHours(CONFIG, UTILITY);
const businessHolidaysJS = require('./utils/businessholidays');
const businessHolidays = businessHolidaysJS.businessHolidays(CONFIG, UTILITY, businessHours);
const kafkaProducer = require('./utils/kafkaProducer').kafkaProducer(CONFIG, UTILITY);
const MASTERDATA = require('./utils/masterdata').masterdata(CONFIG, UTILITY, TAGS, MESSAGESCODE);
const STATIONJS = require('./src/station');
const log = bunyan.createLogger({ name: `index`, level: CONFIG.logger.loglevel });
const stationMap = [];
const substationTags = TAGS.substationtags;
/**
 * Update businessHours based on socket event
 */
emitter.on('businesshours', (data) => {
    businessHours.getAllBusinessHours();
});

/**
 * Update businessholidays based on socket event
 */
emitter.on('businessholidays', (data) => {
    businessHolidays.getAllBusinessHolidays();
});

emitter.on('logmessage', (data) => {
    let topic_name = CONFIG.topicname;
    kafkaProducer.sendMessage(topic_name, data);
});
/**
 * Update station update based on socket event
 */
emitter.on('substation', async (data) => {
    for (var i = 0; i < stationMap.length; i++) {
        // Bug RA-I378 
        if (data[substationTags.SUBLINEID_TAG] === CONFIG.sublineid && data[substationTags.SUBSTATIONID_TAG] == stationMap[i].substationid) {
            log.error(`Substation update event triggered`);
            stationMap[i].updateStation(data);
        }
    }
});

function initStation() {
    kafkaProducer.init();
    for (var i = 0; i < MASTERDATA.stationInfo.length; i++) {
        const obj = STATIONJS.stations(CONFIG, MASTERDATA.stationInfo[i], UTILITY, TAGS, MESSAGESCODE, emitter, businessHours, businessHolidays);
        // wait for 5 second to get required information like element schema
        setTimeout(() => {
            // TODO initialize kafka
            obj.initializeKafka();
        }, 5 * 1000);
        stationMap.push(obj);
    }
}

/**
 * Get businessHolidays
 */
businessHolidaysJS.emitter.on('init', () => {
    // Got current businessHolidays
    log.error(`businessHolidays records fetched sucessfully`);
    getMasterData();
})

async function getMasterData() {
    await MASTERDATA.getStationInformation();
    initStation();
}
/**
 * Get Current shift
 */
businessHoursJS.emitter.on('init', () => {
    // Got current businessHours
    log.error(`businessHours records fetched sucessfully`);
    businessHolidays.getAllBusinessHolidays();
})
/**
 * Authenticate E.A. before initialization
 */
authJS.emitter.on('init', () => {
    log.error(`Authentication done successfully`);
    businessHours.getAllBusinessHours();
    activesession.updateSessionTime();
})

auth.getAuthentication();
