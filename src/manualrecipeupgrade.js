'use strict'
module.exports.manualrecipeupgrade = manualrecipeupgrade;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
const InterfaceService = require('../service/interface.service').InterfaceService;

function manualrecipeupgrade(config, substation, PARAMETERS, ORDER, utility, tags, MESSAGESCODE) {
  const substationTags = tags.substationtags;
  const orderdetailsTags = tags.orderdetailstags;
  const checkoutTags = tags.checkouttags;
  const parameterTags = tags.parametertags;
  const staticTags = tags.statictags;
  const socketio = config.feedbacktoplcsocketio;
  const elements = config.elements;
  const defaults = config.defaults;

  let lineid = substation[substationTags.LINEID_TAG];
  let sublineid = substation[substationTags.SUBLINEID_TAG];
  let substationname = substation[substationTags.NAME_TAG];
  let substationid = substation[substationTags.SUBSTATIONID_TAG];
  let erpcode = substation[substationTags.ERPCODE_TAG];
  let retryServerTimer = defaults.retryServerTimer; // in seconds
  const feebackWriteCount = defaults.maxPLCRetryReceipeCount;
  const retryToPLCTimer = defaults.retryToPLCTimer; // in milliseconds
  const resetValueDealyTime = defaults.resetValueDealyTime || 2;

  let writeManualRecipeUpgradeResultFlag = false;
  let ManualRecipeUpgradeResult;
  let ManualRecipeUpgradeResultCount = 0;
  let writeManualRecipeUpgradeResultTimer;

  let resetManualRecipeUpgradeResultFlag = false;

  let resetManualRecipeUpgradeResultCount = 0;

  let previousvalidatebit = 0;

  let writeRecipeFlag = false;
  let RecipeCount = 0;
  let writeRecipeTimer;

  let writeBomFlag = false;
  let BomCount = 0;
  let writeBomTimer;

  const log = bunyan.createLogger({ name: `ManualRecipeUpgrade_${substationid}`, level: config.logger.loglevel });

  return {
    recipeData: [],
    bomData: [],
    /**
      * Update Station Infomration
      */
    updateStationInfomraton(stationInfo) {
      lineid = stationInfo[substationTags.LINEID_TAG];
      sublineid = stationInfo[substationTags.SUBLINEID_TAG];
      stationname = stationInfo[substationTags.NAME_TAG];
      substationid = stationInfo[substationTags.SUBSTATIONID_TAG];
      stationid = substation[substationTags.STATIONID_TAG];
      erpcode = substation[substationTags.ERPCODE_TAG];
      reworkpcode = substation[substationTags.REWORKCODE_TAG];
    },
    /**
         */
    getRecipeParameter() {
      const recipeparameters = [];
      PARAMETERS.parametersList.filter((item) => {
        if (item[parameterTags.PARAMETERCATEGORY_TAG] === defaults.recipeparameters) {
          recipeparameters.push(item);
        }
      })
      return recipeparameters;
    },
    /**
         */
    getBOMParameter() {
      const bomparameters = [];
      PARAMETERS.parametersList.filter((item) => {
        if (item[parameterTags.PARAMETERCATEGORY_TAG] === defaults.bomparameters) {
          bomparameters.push(item);
        }
      })
      return bomparameters;
    },
    processStationData(data1) {
      let data = utility.cloneDeep(data1);
      let removePrefix = 'q_';
      let removeParameter = 's_';
      data = utility.modifyObject(data, removePrefix, removeParameter);
      // check if feedback is written successfully on PLC or not
      if (data[staticTags.MANUALRECIPEDOWNLOADTRIGGER_TAG] === 1) {
        this.ManualRecipeUpgradeCheckFeedbacktoPLC(data);
      }
      if (!data[staticTags.MANUALRECIPEDOWNLOADTRIGGER_TAG]) {
        if (previousvalidatebit) {
          resetManualRecipeUpgradeResultFlag = true;
          resetManualRecipeUpgradeResultCount = 0;
        }
        this.resetAck(data);
      }
      if (!data[staticTags.MANUALRECIPEDOWNLOADTRIGGER_TAG]) {
        previousvalidatebit = 0;
      }

      if (previousvalidatebit === 0 && data[staticTags.MANUALRECIPEDOWNLOADTRIGGER_TAG] === 1) {
        log.error(`Manualrecipeupgrade Triggered ${JSON.stringify(data)}`);
        previousvalidatebit = 1;
        resetManualRecipeUpgradeResultFlag = false;
        this.write = false;
        this.reset = false;
        this.CommonManualRecipeUpgrade(data);
      }
    },
    CommonManualRecipeUpgrade(data) {
      const isOrderOk = this.checkOrder();
      if (isOrderOk) {
        this.checkLastStationPartStatus(data);
      }
    },
    async checkLastStationPartStatus(plcdata) {
      const elementName = elements.partstatus || 'partstatus';
      try {
        // const ordername = runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG];
        // no need to add query for stationid we need to check the last substation result
        /*
            query = `query=lineid==1%26%26mainid=="MainId1"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
        */
        let query = `query=${[checkoutTags.LINEID_TAG]}==${lineid}`;
        query += `%26%26${[checkoutTags.MAINID_TAG]}=="${plcdata[staticTags.MAINID_TAG]}"`;
        query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
        log.trace(`Check Part Status in Last Station query : ${query}`)
        const response = await elementService.getElementRecords(elementName, query)
        if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
          if (response.data && response.data.results && response.data.results.length > 0) {
            const mainidOrder = ORDER.runningOrder.filter((item) => {
              const { orderdata } = item;
              return response.data.results[0][orderdetailsTags.ORDERNAME_TAG] === orderdata[orderdetailsTags.ORDERNAME_TAG];
            });
            if (mainidOrder.length > 0) {
              const runningOrder = mainidOrder[0];
              // check the last substation result for mainid and orderid
              this.pullRecipe(runningOrder);
            }
            else {
              log.error(`No RunningOrder found for mainid ${plcdata[staticTags.MAINID_TAG]}`);
              ManualRecipeUpgradeResult = -1;
              writeManualRecipeUpgradeResultFlag = true;
              this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);
            }
          } else {
            log.error(`No record found in partstatus for mainid ${plcdata[staticTags.MAINID_TAG]}`);
            ManualRecipeUpgradeResult = -1;
            writeManualRecipeUpgradeResultFlag = true;
            this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);

          }
        } else {
          utility.checkSessionExpired(response.data);
          log.error(`Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`);
          ManualRecipeUpgradeResult = -1;
          writeManualRecipeUpgradeResultFlag = true;
          this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);

        }
      } catch (ex) {
        log.error(`Exception to fetch data for element : ${elementName}`);
        const messageObject = ex.response ? ex.response.data : ex
        log.error(messageObject);
        ManualRecipeUpgradeResult = -1;
        writeManualRecipeUpgradeResultFlag = true;
        this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);
      }
    },
    /**
         * This method check the Order is running or not
         * @param {Object} plcdata 
         */
    checkOrder() {
      const runningOrder = ORDER.runningOrder;
      if (runningOrder.length === 0) {
        log.error(`${MESSAGESCODE.XXX03016}`);
        ManualRecipeUpgradeResult = -1;
        writeManualRecipeUpgradeResultFlag = true;
        this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);

        return false;
      }
      return true;
    },
    async pullRecipe(runningOrder) {
      const head = {
        "order_id": runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG],
        "work_center": erpcode,
      };
      const response = await InterfaceService.getRecipe(head);
      if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        if (response.data.returncode === '0') {
          log.error(`Recipe Pull Successfully`);
          this.prepareRecipeList(response.data.body);
          this.pullBom(runningOrder);
        }
        else {
          log.error(`Recipe Pull error`);
          log.error(response.data);
          ManualRecipeUpgradeResult = -1;
          writeManualRecipeUpgradeResultFlag = true;
          this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);
        }
      } else {
        log.error(`Recipe Pull error`);
        log.error(response.data);
        ManualRecipeUpgradeResult = -1;
        writeManualRecipeUpgradeResultFlag = true;
        this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);
      }
    },
    prepareRecipeList(body) {
      body.forEach(recipe => {
        const {
          para_no,
          standard_value,
          max_value,
          min_value,
        } = recipe;
        this.recipeData.push({
          name: `${para_no.toLowerCase()}`,
          value: standard_value
        });
        this.recipeData.push({
          name: `${para_no.toLowerCase()}_max`,
          value: max_value
        });
        this.recipeData.push({
          name: `${para_no.toLowerCase()}_min`,
          value: min_value
        });
      });
      const recipeparas = this.getRecipeParameter();
      this.recipeData = this.recipeData.filter((recipe) => {
        return recipeparas.filter((para) => {
          return para[parameterTags.PARAMETERNAME_TAG] === recipe.name;
        }).length > 0
      })
    },
    async pullBom(runningOrder) {
      const head = {
        "order_id": runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG],
        "work_center": erpcode,
      };
      const response = await InterfaceService.getBom(head);
      if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        if (response.data.returncode === '0') {
          log.error(`Bom Pull Successfully`);
          this.prepareBomList(response.data.body);
          const recipeparas = this.getRecipeParameter();
          const bomparas = this.getBOMParameter();
          if (this.recipeData.length) {
            writeRecipeFlag = true;
            this.recipeWriteEvent();
            log.error('Start Write Recipe');
          } else if (this.bomData.length) {
            writeBomFlag = true;
            this.bomWriteEvent();
            log.error('Start Write BOM');
          } else if (recipeparas.length || bomparas.length) {
            log.error(`Bom & Recipe Data error`);
            ManualRecipeUpgradeResult = -1;
            writeManualRecipeUpgradeResultFlag = true;
            this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);

          } else {
            ManualRecipeUpgradeResult = 1;
            writeManualRecipeUpgradeResultFlag = true;
            this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);
          }

        }
        else {
          log.error(`Bom Pull error`);
          log.error(response.data);
          ManualRecipeUpgradeResult = -1;
          writeManualRecipeUpgradeResultFlag = true;
          this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);
        }
      } else {
        log.error(`Bom Pull error`);
        log.error(response.data);
        ManualRecipeUpgradeResult = -1;
        writeManualRecipeUpgradeResultFlag = true;
        this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);
      }
      // const data = [
      //   {
      //     "mat_part_no": 'bl_mb_0100_06',
      //     "judge_mark": 'bl',
      //     "start_mark": 1,
      //     "length": 3
      //   },
      //   {
      //     "mat_part_no": 'bl_mb_0100_07',
      //     "judge_mark": 'mb',
      //     "start_mark": 2,
      //     "length": 4
      //   },
      //   {
      //     "mat_part_no": 'bl_mb_0100_16',
      //     "judge_mark": '16',
      //     "start_mark": 8,
      //     "length": 2
      //   }
      // ]
      // this.prepareBomList(plcdata, data);
      // writeBomFlag = true;
      // this.bomWriteEvent();
    },
    prepareBomList(body) {
      body.forEach(bom => {
        const { mat_part_no, judge_mark, start_mark, length } = bom;
        this.bomData.push({
          name: `${mat_part_no.toLowerCase()}_shortname`,
          value: judge_mark,
        });
        this.bomData.push({
          name: `${mat_part_no.toLowerCase()}_startaddress`,
          value: start_mark,
        });
        this.bomData.push({
          name: `${mat_part_no.toLowerCase()}_length`,
          value: length,
        });
      });
      const bomparas = this.getBOMParameter();
      this.bomData = this.bomData.filter((bom) => {
        return bomparas.filter((para) => {
          return para[parameterTags.PARAMETERNAME_TAG] === bom.name;
        }).length > 0
      })
    },
    validateRecipe(plcdata) {
      const data = this.recipeData;
      if (data.length) {
        const okRecipeData = [];
        for (let i = 0; i < data.length; i++) {
          const name = data[i].name;
          const value = data[i].value;
          if (typeof plcdata[name] === 'number') {
            let decimalpoint = this.countDecimals(value, name, plcdata[name]);
            plcdata[name] = plcdata[name] ? +plcdata[name].toFixed(decimalpoint) : plcdata[name];
          }
          if (value == plcdata[name]) {
            okRecipeData.push({
              [name]: plcdata[name]
            });
          }
        }
        return okRecipeData.length === data.length;
      } else {
        log.error(`RecipeData not found`);
        return false;
      }

    },
    recipeWriteEvent() {
      const data = this.recipeData;
      if (data.length) {
        for (let i = 0; i < data.length; i++) {
          this.postDatatoSocketPLCWrite(data[i].name, data[i].value);
        }
        clearTimeout(writeRecipeTimer);
        writeRecipeTimer = setTimeout(() => {
          writeRecipeFlag = true;
        }, retryToPLCTimer);
      } else {
        log.error(`RecipeData not found`);
      }
    },
    validateBom(plcdata) {
      const data = this.bomData;
      if (data.length) {
        const okBomData = [];
        for (let i = 0; i < data.length; i++) {
          const name = data[i].name;
          const value = data[i].value;
          if (typeof plcdata[name] === 'number') {
            let decimalpoint = this.countDecimals(value, name, plcdata[name]);
            plcdata[name] = plcdata[name] ? +plcdata[name].toFixed(decimalpoint) : plcdata[name];
          }
          if (value == plcdata[name]) {
            okBomData.push({
              [name]: plcdata[name]
            });
          }
        }
        return okBomData.length === data.length;
      } else {
        log.error(`BomData not found`);
        return false;
      }
    },
    bomWriteEvent() {
      const data = this.bomData;
      if (data.length) {
        for (let i = 0; i < data.length; i++) {
          this.postDatatoSocketPLCWrite(data[i].name, data[i].value);
        }
        clearTimeout(writeBomTimer);
        writeBomTimer = setTimeout(() => {
          writeBomFlag = true;
        }, retryToPLCTimer);
      } else {
        log.error(`BomData not found`);
      }
    },
    countDecimals(value, param, plcval) {
      try {
        if (Math.floor(value) === Number(value) || 0) return 0;
        return value.toString().split(".")[1].length || 0;
      } catch (ex) {
        log.error(`Exeption in checking decimalcount parametername : ${param}, value : ${value}, plcvalue : ${plcval}`);
      }
      return value;
    },

    ManualRecipeUpgradeCheckFeedbacktoPLC(data) {
      if (writeRecipeFlag) {
        const isValid = this.validateRecipe(data);
        // if recipe is not downloaded properly to PLC then retry for 3 times with some delay i.e. 500ms
        if (writeRecipeFlag && !isValid && RecipeCount < feebackWriteCount) {
          log.error(`Retry write Recipe to PLC`);
          // write recipe on PLC
          clearTimeout(writeRecipeTimer);
          writeRecipeFlag = false;
          // plc polling is reduced to 50 ms
          writeRecipeTimer = setTimeout(() => {
            writeRecipeFlag = true;
          }, retryToPLCTimer);

          RecipeCount++;
          this.recipeWriteEvent();

        } else if (writeRecipeFlag && !isValid && RecipeCount === feebackWriteCount) {
          log.error(`Error in write Recipe to PLC`);
          // send error to Recipe Management App in write recipe after 3 times
          writeRecipeFlag = false;

        } else if (writeRecipeFlag && isValid) {
          // if all ok then stop validation
          // send success to Recipe Management App
          writeRecipeFlag = false;
          log.error(`Recipe written successfully on PLC at `);
          if (this.bomData.length) {
            writeBomFlag = true;
          } else {
            ManualRecipeUpgradeResult = 1;
            writeManualRecipeUpgradeResultFlag = true;
          }

        }
      }

      if (writeBomFlag) {
        const isValid = this.validateBom(data);
        // if bom is not downloaded properly to PLC then retry for 3 times with some delay i.e. 500ms
        if (writeBomFlag && !isValid && BomCount < feebackWriteCount) {
          log.error(`Retry write Bom to PLC`);
          // write bom on PLC
          clearTimeout(writeBomTimer);
          writeBomFlag = false;
          // plc polling is reduced to 50 ms
          writeBomTimer = setTimeout(() => {
            writeBomFlag = true;
          }, retryToPLCTimer);

          BomCount++;
          this.bomWriteEvent();

        } else if (writeBomFlag && !isValid && BomCount === feebackWriteCount) {
          log.error(`Error in write Bom to PLC`);
          // send error to Bom Management App in write bom after 3 times
          writeBomFlag = false;

        } else if (writeBomFlag && isValid) {
          // if all ok then stop validation
          // send success to Bom Management App
          writeBomFlag = false;
          log.error(`Bom written successfully on PLC at `);
          ManualRecipeUpgradeResult = 1;
          writeManualRecipeUpgradeResultFlag = true;
        }
      }

      // ManualRecipeUpgradeResult
      if (writeManualRecipeUpgradeResultFlag) {
        const isValid = ManualRecipeUpgradeResult === data[staticTags.MANUALRECIPEDOWNLOADRESULT_TAG] ? true : false;
        if (!isValid && ManualRecipeUpgradeResultCount < feebackWriteCount) {
          clearTimeout(writeManualRecipeUpgradeResultTimer);
          writeManualRecipeUpgradeResultFlag = false;
          // plc polling is reduced to 50 ms
          writeManualRecipeUpgradeResultTimer = setTimeout(() => {
            writeManualRecipeUpgradeResultFlag = true;
          }, retryToPLCTimer);

          ManualRecipeUpgradeResultCount++;
          this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);

        } else if (!isValid && ManualRecipeUpgradeResultCount === feebackWriteCount) {
          log.error(`Error in Writing ManualRecipeUpgradeResult`);
          writeManualRecipeUpgradeResultFlag = false;

        } else if (isValid) {
          writeManualRecipeUpgradeResultFlag = false;
        }
      }
    },
    resetAck(data) {
      const isManualRecipeUpgradeResult = 0 === data[staticTags.MANUALRECIPEDOWNLOADRESULT_TAG] ? true : false;
      // wait for 2 seconds and then reset values
      if (!this.reset && resetManualRecipeUpgradeResultFlag) {
        this.reset = true;
        setTimeout(() => {
          this.write = true;
        }, resetValueDealyTime * 1000);
      } else if (this.write && resetManualRecipeUpgradeResultFlag) {
        // reset ManualRecipeUpgradeResult 
        if (resetManualRecipeUpgradeResultFlag && !isManualRecipeUpgradeResult && resetManualRecipeUpgradeResultCount < feebackWriteCount) {
          clearTimeout(this.resetManualrecipeupgradeResultTimer);
          resetManualRecipeUpgradeResultFlag = false;
          // plc polling is reduced to 50 ms
          this.resetManualrecipeupgradeResultTimer = setTimeout(() => {
            resetManualRecipeUpgradeResultFlag = true;
          }, retryToPLCTimer);
          resetManualRecipeUpgradeResultCount++;
          this.bomData = [];
          this.recipeData = [];
          ManualRecipeUpgradeResult = 0;
          this.postDatatoSocketPLCWrite(staticTags.MANUALRECIPEDOWNLOADRESULT_TAG, ManualRecipeUpgradeResult);

        } else if (!isManualRecipeUpgradeResult && resetManualRecipeUpgradeResultCount === feebackWriteCount) {
          log.error(`Error in Reset ManualRecipeUpgradeResult`);
          resetManualRecipeUpgradeResultCount++;
          // after 3 times retry error in write reset values on PLC
          resetManualRecipeUpgradeResultFlag = false;

        } else if (isManualRecipeUpgradeResult) {
          // reset values written successfully on PLC
          resetManualRecipeUpgradeResultFlag = false;
        }
      }
    },
    /**
      * This method send the data to Pre-Analyzer for writing into PLC
      * @param {Object} payload 
      */
    async postDatatoSocketPLCWrite(parametername, value) {
      let payload = {};
      payload[parameterTags.SUBSTATIONID_TAG] = substationid;
      payload[parameterTags.PARAMETERNAME_TAG] = parametername;
      payload.value = value;
      log.error(`PLC Write Payload ${JSON.stringify(payload)}`);
      let url = `${socketio.protocol}://${socketio.host}:${socketio.port}/${socketio.namespace}/${socketio.eventname}_plcwrite`;
      try {
        let response = await socketService.post(url, payload);
        log.trace(`Payload for Pre-Analyzer ${JSON.stringify(payload)}`);
        if (response && response.status == utility.HTTP_STATUS_CODE.SUCCESS && response.data) {
          log.trace(`Data send successfully on socket for ${substationid} - ${JSON.stringify(response.data)}`);
        } else {
          log.error(`Error in sending data to socket for PLC Live bit status code ${response.status} ${JSON.stringify(response.data)}`);
        }

      } catch (ex) {
        log.error(`Exception in writing data to socket ${ex}`);
      }
    },
  }
}