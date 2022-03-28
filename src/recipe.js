'use strict'
module.exports.recipe = recipe;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
function recipe(config, substation, ORDER, utility, tags, MESSAGESCODE, emitter) {
    const substationTags = tags.substationtags;
    const recipedetailsTags = tags.recipedetailstags;
    const parameterTags = tags.parametertags;
    const socketio = config.socketio;
    const feedbacktoplcsocketio = config.feedbacktoplcsocketio;
    const defaults = config.defaults;
    let lineid = substation[substationTags.LINEID_TAG];
    let sublineid = substation[substationTags.SUBLINEID_TAG];
    let stationname = substation[substationTags.NAME_TAG];
    let substationid = substation[substationTags.SUBSTATIONID_TAG];
    const log = bunyan.createLogger({ name: `Recipe_${substationid}`, level: config.logger.loglevel});
    const maxPLCRetryCount = defaults.maxPLCRetryReceipeCount;
    const plcRetryDelay = 500;
    let counter = 0;
    let writeRecipeFlag = false;
    let writeRecipeTimer;
    let getStationParametersFlag = true;
    let getRecipeStationParametersFlag = true;
    return {
        /**
         * Update Station Infomration
         */
        updateStationInfomraton(stationInfo) {
            lineid = stationInfo[substationTags.LINEID_TAG];
            sublineid = stationInfo[substationTags.SUBLINEID_TAG];
            stationname = stationInfo[substationTags.NAME_TAG];
            substationid = stationInfo[substationTags.SUBSTATIONID_TAG];
        },
        
        /**
         * Intialize the socket listener on startup of E.A.
         */
        initEmitter() {
            /**
             * Recipe Upload Event recived from Recipe Management App 
             */
            emitter.on('recipeupload', (data) => {
                const recipeLineId = data[recipedetailsTags.LINEID_TAG];
                const recipeSubLineId = data[recipedetailsTags.SUBLINEID_TAG];
                const recipesubStationId = data[recipedetailsTags.SUBSTATIONID_TAG];
                if (lineid === recipeLineId && sublineid === recipeSubLineId && substationid === recipesubStationId) {
                    log.error(`Recipe Upload event triggered`);
                    counter = 0;
                    this.manualRecipeParam = data.recipeparameter;
                    this.recipeWriteEvent();
                }    
            });
            /**
             * Recipe Download Event recived from Recipe Management App 
             */
            emitter.on('recipedownload', (data) => {
                const recipeLineId = data[recipedetailsTags.LINEID_TAG];
                const recipeSubLineId = data[recipedetailsTags.SUBLINEID_TAG];
                const recipesubStationId = data[recipedetailsTags.SUBSTATIONID_TAG];
                if (lineid === recipeLineId && sublineid === recipeSubLineId && substationid === recipesubStationId) {
                    log.error(`Recipe Download event triggered`);
                    getRecipeStationParametersFlag = false; 
                }
            });
            /**
             * Parameter Upload Event recived from Parameter Configuration App
             */
            emitter.on('parameterupload', (data) => {
                const parameterLineId = data[parameterTags.LINEID_TAG];
                const parameterSubLineId = data[parameterTags.SUBLINEID_TAG];
                const parametersubStationId = data[parameterTags.SUBSTATIONID_TAG];
                if (lineid === parameterLineId && sublineid === parameterSubLineId && substationid === parametersubStationId) {
                    getStationParametersFlag = false;
                }
            });
        },
        /**
         * This method check recipe written on PLC. If not then retry for configurable number of counter
         * @param {Object} data 
         */
        processStationRecipe(data) {
            // validate recipe data and plc data is correct or not
            // get parameters in PLC
            if(!getStationParametersFlag) {
                getStationParametersFlag = true;
                this.getStationParameters(data);
            }
            // get recipe parameters in PLC
            if(!getRecipeStationParametersFlag) {
                getRecipeStationParametersFlag = true;
                this.getRecipeParameters(data);
            }

            this.currentRecipe = data;
            if(writeRecipeFlag) {
                const isValid = this.validateRecipe(data);
                // if recipe is not downloaded properly to PLC then retry for 3 times with some delay i.e. 500ms
                if(writeRecipeFlag && !isValid && counter < maxPLCRetryCount) {
                    log.error(`Retry write Recipe to PLC`);
                    // write recipe on PLC
                    clearTimeout(writeRecipeTimer);
                    writeRecipeFlag = false;
                    // plc polling is reduced to 50 ms
                    writeRecipeTimer = setTimeout(()=>{
                        writeRecipeFlag = true;
                    }, plcRetryDelay);

                    counter++;
                    this.recipeWriteEvent();

                } else if(writeRecipeFlag && !isValid && counter === maxPLCRetryCount) {
                    log.error(`Error in write Recipe to PLC`);
                    // send error to Recipe Management App in write recipe after 3 times
                    writeRecipeFlag = false;
                    const socketEventName = `upload_${lineid}_${sublineid}_${substationid}`;
                    // send response as 0
                    this.postDatatoSocket(socketEventName, {CheckRecipeDownloadResult: 0});

                } else if(writeRecipeFlag && isValid) {
                    // if all ok then stop validation
                    // send success to Recipe Management App
                    writeRecipeFlag = false;
                    log.error(`Recipe written successfully on PLC at attempt : ${counter}`);
                    const socketEventName = `upload_${lineid}_${sublineid}_${substationid}`;
                    // send response as 1 
                    this.postDatatoSocket(socketEventName, {CheckRecipeDownloadResult: 1});
                }
            }

        },
        /**
         * This method write the Recipe triggered from RMA or PLC on PLC
         * @param {Object} data 
         */
        recipeWriteEvent() {
            /*
                payload = {
                "lineid": "Line1",
                "sublineid": "sub-01",
                "substationid": "ST01",
                "name": "producttype",
                "value": "Product 1"
                } 
            */
            const runningRecipe = this.manualRecipeParam;
            if(runningRecipe.length > 0) {
                for ( var i = 0; i < runningRecipe.length; i++) {
                    var obj = {}
                    obj[parameterTags.LINEID_TAG] = lineid;
                    obj[parameterTags.SUBLINEID_TAG] = sublineid;
                    obj[parameterTags.SUBSTATIONID_TAG] = substationid;
                    obj[parameterTags.PARAMETERNAME_TAG] = runningRecipe[i][recipedetailsTags.PARAMETERNAME_TAG];
                    obj.value = runningRecipe[i][recipedetailsTags.PARAMETERVALUE_TAG];
                    this.postDatatoSocketPLCWrite(obj);
                }
                clearTimeout(writeRecipeTimer);
                writeRecipeTimer = setTimeout(()=>{
                    writeRecipeFlag = true;
                }, plcRetryDelay);
            } else {
                log.error(`Recipe not found in order`);
            }
        },
        /**
         * Get all the current Recipe parameters and send it to Recipe Managment App
         */
        getRecipeParameters(data) {
            const obj = data;
            obj.lineid = lineid;
            obj.sublineid = sublineid;
            obj.substationid = substationid;
            // return the recipe to RMA
            const socketEventName = `download_${lineid}_${sublineid}_${substationid}`;
            this.postDatatoSocket(socketEventName, obj);
        },
        /**
         * Get all the parameters of the substation and send it to Prameter Configuration App 
         */
        getStationParameters(data) {
            const obj = data;
            obj.lineid = lineid;
            obj.sublineid = sublineid;
            obj.substationid = substationid;
            // return the recipe to RMA
            const socketEventName = `parameter_${lineid}_${sublineid}_${substationid}`;
            this.postDatatoSocket(socketEventName, obj);
        },
        countDecimals(value) {
            if(Math.floor(value) === value) return 0;
            return value.toString().split(".")[1].length || 0; 
        },
        /**
         * This method validate the each parameter of Recipe written on PLC and actual parameter in Recipe details
         * @param {Object} data 
         */
        validateRecipe(data) {
            const runningRecipe = this.manualRecipeParam;
            if(runningRecipe.length > 0) {
                const okParamArray = [];
                for ( var i = 0; i < runningRecipe.length; i++) {
                    const parametername = runningRecipe[i][recipedetailsTags.PARAMETERNAME_TAG];
                    let parametervalue = runningRecipe[i][recipedetailsTags.PARAMETERVALUE_TAG];
                    if(typeof data[parametername] === 'number') {
                        let decimalpoint = this.countDecimals(parametervalue);
                        data[parametername] = data[parametername] ? +data[parametername].toFixed(decimalpoint) : data[parametername];
                    }
                    if(parametervalue === data[parametername]) {
                        okParamArray.push({[parametername]: data[parametername], status: true});
                    }
                }
                // if parameters in recipe == parameter in plc are equal then return true otherwise false
                return runningRecipe.length === okParamArray.length ? true : false;
            } else {
                log.error(`Recipe not found in order`);
                return false;
            }
        },
        /**
        * This method send the Result to Recipe Management App and Parameter Configuration App
        * @param {Object} payload 
        */
        async postDatatoSocket(eventname, payload) {
            let url = `${socketio.protocol}://${socketio.host}:${socketio.port}/update/${eventname}`; 
            try {
                let response = await socketService.post(url, payload);
                log.trace(`Payload for Apps ${JSON.stringify(payload)}`);
                if(response && response.status == utility.HTTP_STATUS_CODE.SUCCESS && response.data){
                    log.trace(`Data send successfully on socket for ${substationid} - ${JSON.stringify(response.data)}`);
                } else {
                    log.error(`Error in sending data to socket for PLC Live bit status code ${response.status} ${JSON.stringify(response.data)}`);
                }
                
            } catch (ex) {
                log.error(`Exception in writing data to socket ${ex}`);
            }
        },
        /**
        * This method send the data to Pre-Analyzer for writing into PLC
        * @param {Object} payload 
        */
        async postDatatoSocketPLCWrite(payload) {
            let url = `${feedbacktoplcsocketio.protocol}://${feedbacktoplcsocketio.host}:${feedbacktoplcsocketio.port}/${feedbacktoplcsocketio.namespace}/${feedbacktoplcsocketio.eventname}_plcwrite`; 
            try {
                let response = await socketService.post(url, payload);
                log.trace(`Payload for Pre-Analyzer ${JSON.stringify(payload)}`);
                if(response && response.status == utility.HTTP_STATUS_CODE.SUCCESS && response.data){
                    log.trace(`Data send successfully on socket for ${substationid} - ${JSON.stringify(response.data)}`);
                } else {
                    log.error(`Error in sending data to socket for PLC Live bit status code ${response.status} ${JSON.stringify(response.data)}`);
                }
                
            } catch (ex) {
                log.error(`Exception in writing data to socket ${ex}`);
            }
        }
    }
}
  