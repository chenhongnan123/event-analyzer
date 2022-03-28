const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const apiService = require('../service/api.service.js').ApiService;
const authService = require('../service/auth.service.js').AuthService;
const bunyan = NodePackage.bunyan;
const EventEmitter = NodePackage.EventEmitter;
EventEmitter.prototype._maxListeners = 0;
const Emitter = new EventEmitter.EventEmitter();
module.exports.auth = auth;
module.exports.emitter = Emitter;
function auth(config, utility, MESSAGESCODE, emitter){
    const credential = config.credential;
    const defaults = config.defaults;
    const requestTimeout = defaults.requesttimeout || 40;
    const retryServer = defaults.retry || 10;    
    apiService.setTimeout(requestTimeout);
    // set loginType in axios header 
    apiService.setDefaultHeader(config.loginType);
    const log = bunyan.createLogger({ name: `auth`, level: config.logger.loglevel || 20});
    return {
        name : `authentication`,
        onStartup : false,
        authResponse:{},
        /**
         * This method logged in to server using credentials configured in config file
        */
        async getAuthentication(isReAuth){
            try{
                const payload = { 
                    identifier : credential.identifier, 
                    password : credential.password
                }
                if(isReAuth) {
                    log.error(`${MESSAGESCODE.XXX01001}`);
                    this.writeMessageToKafka('XXX01001');
                }
                const response = await authService.authenticate(payload);
                const {status, data} = response; 
                if(status === utility.HTTP_STATUS_CODE.SUCCESS && data){ 
                    apiService.setHeader(data.sessionId);
                    if(!this.onStartup){
                        this.onStartup = true;
                        Emitter.emit('init');
                    }
                } else {
                    // retry for authentication
                    log.error(`${MESSAGESCODE.XXX01003} ${JSON.stringify(response.data)}`);
                    if(isReAuth) {
                        this.writeMessageToKafka('XXX01003');
                    }
                    await utility.setTimer(retryServer); 
                    await this.getAuthentication(isReAuth);
                }
            } catch(ex) {
                log.error(`${MESSAGESCODE.XXX01002} ${ex}`);
                if(isReAuth) {
                    this.writeMessageToKafka('XXX01002');
                }
                await utility.setTimer(retryServer); 
                await this.getAuthentication(isReAuth);
            }
        },
        writeMessageToKafka(logcode) {
            let Obj = {
                timestamp: new Date().valueOf(),
                logtype: "ERROR",
                logcode: logcode,
                logsource: config.source,
                metadata: JSON.stringify({ sublineid : config.sublineid})
            } 
          //  emitter.emit('logmessage', Obj);
        }
    }
}