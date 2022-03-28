'use strict'
module.exports.autorecipeupgrade = autorecipeupgrade;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
const InterfaceService = require('../service/interface.service').InterfaceService;

function autorecipeupgrade(config, substation, PARAMETERS, ORDER, utility, tags, MESSAGESCODE) {
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
  let reworkpcode = substation[substationTags.REWORKCODE_TAG];
  let retryServerTimer = defaults.retryServerTimer; // in seconds
  const feebackWriteCount = defaults.maxPLCRetryReceipeCount;
  const retryToPLCTimer = defaults.retryToPLCTimer; // in milliseconds
  const resetValueDealyTime = defaults.resetValueDealyTime || 2;

  let writeAutoRecipeUpgradeResultFlag = false;
  let AutoRecipeUpgradeResult;
  let AutoRecipeUpgradeResultCount = 0;
  let writeAutoRecipeUpgradeResultTimer;

  let resetAutoRecipeUpgradeResultFlag = false;

  let resetAutoRecipeUpgradeResultCount = 0;

  let previousvalidatebit = 0;

  let writeRecipeFlag = false;
  let RecipeCount = 0;
  let writeRecipeTimer;

  let writeBomFlag = false;
  let BomCount = 0;
  let writeBomTimer;

  const log = bunyan.createLogger({ name: `AutoRecipeUpgrade_${substationid}`, level: config.logger.loglevel });

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
      if (data[staticTags.AUTORECIPEDOWNLOADTRIGGER_TAG] === 1) {
        this.AutoRecipeUpgradeCheckFeedbacktoPLC(data);
      }
      if (!data[staticTags.AUTORECIPEDOWNLOADTRIGGER_TAG]) {
        if (previousvalidatebit) {
          resetAutoRecipeUpgradeResultFlag = true;
          resetAutoRecipeUpgradeResultCount = 0;
        }
        this.resetAck(data);
      }
      if (!data[staticTags.AUTORECIPEDOWNLOADTRIGGER_TAG]) {
        previousvalidatebit = 0;
      }

      if (previousvalidatebit === 0 && data[staticTags.AUTORECIPEDOWNLOADTRIGGER_TAG] === 1) {
        log.error(`Autorecipeupgrade Triggered ${JSON.stringify(data)}`);
        previousvalidatebit = 1;
        resetAutoRecipeUpgradeResultFlag = false;
        AutoRecipeUpgradeResultCount = 0;
        resetAutoRecipeUpgradeResultCount = 0;
        RecipeCount = 0;
        BomCount = 0;
        this.write = false;
        this.reset = false;
        this.CommonAutoRecipeUpgrade(data);
      }
    },
    CommonAutoRecipeUpgrade(data) {
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
              AutoRecipeUpgradeResult = -1;
              writeAutoRecipeUpgradeResultFlag = true;
              this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);
            }
          } else {
            log.error(`No record found in partstatus for mainid ${plcdata[staticTags.MAINID_TAG]}`);
            AutoRecipeUpgradeResult = -1;
            writeAutoRecipeUpgradeResultFlag = true;
            this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

          }
        } else {
          utility.checkSessionExpired(response.data);
          log.error(`Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`);
          AutoRecipeUpgradeResult = -1;
          writeAutoRecipeUpgradeResultFlag = true;
          this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

        }
      } catch (ex) {
        log.error(`Exception to fetch data for element : ${elementName}`);
        const messageObject = ex.response ? ex.response.data : ex
        log.error(messageObject);
        AutoRecipeUpgradeResult = -1;
        writeAutoRecipeUpgradeResultFlag = true;
        this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);
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
        AutoRecipeUpgradeResult = -1;
        writeAutoRecipeUpgradeResultFlag = true;
        this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

        return false;
      }
      return true;
    },
    async pullRecipe(runningOrder) {
      debugger;
      const head = {
        "order_id": runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG],
        "work_center": erpcode,
      };
      const response = await InterfaceService.getRecipe(head);
      if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        if (response.data.returncode === '0') {
          log.error(`Recipe Pull Successfully : ${JSON.stringify(response.data.body)}`);
          this.prepareRecipeList(response.data.body);
          this.pullBom(runningOrder);
        }
        else {
          log.error(`Recipe Pull error`);
          log.error(response.data);
          AutoRecipeUpgradeResult = -1;
          writeAutoRecipeUpgradeResultFlag = true;
          this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

        }
      } else {
        log.error(`Recipe Pull error`);
        log.error(response.data);
        AutoRecipeUpgradeResult = -1;
        writeAutoRecipeUpgradeResultFlag = true;
        this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

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
      }); debugger;
      log.error(`Recipe Data: ${this.recipeData}`);
    },
    async pullBom(runningOrder) {
      const head = {
        "order_id": runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG],
        "work_center": erpcode,
      };
      const response = await InterfaceService.getBom(head);
      if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        if (response.data.returncode === '0') {
          log.error(`Bom Pull Successfully: ${JSON.stringify(response.data.body)}`);
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
          } else if (!recipeparas.length && !bomparas.length) {
            log.error(`Bom & Recipe Data error`);
            AutoRecipeUpgradeResult = -1;
            writeAutoRecipeUpgradeResultFlag = true;
            this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);
          } else {
            log.error('No Bom & Recipe Data to Write');
            AutoRecipeUpgradeResult = -1;
            writeAutoRecipeUpgradeResultFlag = true;
            this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);
          }
        }
        else {
          log.error(`Bom Pull error`);
          log.error(response.data);
          AutoRecipeUpgradeResult = -1;
          writeAutoRecipeUpgradeResultFlag = true;
          this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

        }
      } else {
        log.error(`Bom Pull error`);
        log.error(response.data);
        AutoRecipeUpgradeResult = -1;
        writeAutoRecipeUpgradeResultFlag = true;
        this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

      }
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
      const bomparas = this.getBOMParameter(); debugger;
      this.bomData = this.bomData.filter((bom) => {
        return bomparas.filter((para) => {
          return para[parameterTags.PARAMETERNAME_TAG] === bom.name;
        }).length > 0
      });
      log.error(`BOM Data: ${this.bomData}`);

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
        debugger
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

    AutoRecipeUpgradeCheckFeedbacktoPLC(data) {
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
            AutoRecipeUpgradeResult = 1;
            writeAutoRecipeUpgradeResultFlag = true;
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
          AutoRecipeUpgradeResult = 20;
          writeAutoRecipeUpgradeResultFlag = true;
        } else if (writeBomFlag && isValid) {
          // if all ok then stop validation
          // send success to Bom Management App
          writeBomFlag = false;
          log.error(`Bom written successfully on PLC at `);
          AutoRecipeUpgradeResult = 1;
          writeAutoRecipeUpgradeResultFlag = true;
        }
      }

      // AutoRecipeUpgradeResult
      if (writeAutoRecipeUpgradeResultFlag) {
        const isValid = AutoRecipeUpgradeResult === data[staticTags.AUTORECIPEDOWNLOADRESULT_TAG] ? true : false;
        if (!isValid && AutoRecipeUpgradeResultCount < feebackWriteCount) {
          clearTimeout(writeAutoRecipeUpgradeResultTimer);
          writeAutoRecipeUpgradeResultFlag = false;
          // plc polling is reduced to 50 ms
          writeAutoRecipeUpgradeResultTimer = setTimeout(() => {
            writeAutoRecipeUpgradeResultFlag = true;
          }, retryToPLCTimer);

          AutoRecipeUpgradeResultCount++;
          this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

        } else if (!isValid && AutoRecipeUpgradeResultCount === feebackWriteCount) {
          log.error(`Error in Writing AutoRecipeUpgradeResult`);
          writeAutoRecipeUpgradeResultFlag = false;

        } else if (isValid) {
          writeAutoRecipeUpgradeResultFlag = false;
        }
      }
    },
    resetAck(data) {
      const isAutoRecipeUpgradeResult = 0 === data[staticTags.AUTORECIPEDOWNLOADRESULT_TAG] ? true : false;
      // wait for 2 seconds and then reset values
      if (!this.reset && resetAutoRecipeUpgradeResultFlag) {
        this.reset = true;
        setTimeout(() => {
          this.write = true;
        }, resetValueDealyTime * 1000);
      } else if (this.write && resetAutoRecipeUpgradeResultFlag) {
        // reset AutoRecipeUpgradeResult
        if (resetAutoRecipeUpgradeResultFlag && !isAutoRecipeUpgradeResult && resetAutoRecipeUpgradeResultCount < feebackWriteCount) {
          clearTimeout(this.resetAutorecipeupgradeResultTimer);
          resetAutoRecipeUpgradeResultFlag = false;
          // plc polling is reduced to 50 ms
          this.resetAutorecipeupgradeResultTimer = setTimeout(() => {
            resetAutoRecipeUpgradeResultFlag = true;
          }, retryToPLCTimer);
          resetAutoRecipeUpgradeResultCount++;
          this.bomData = [];
          this.recipeData = [];
          AutoRecipeUpgradeResult = 0;
          this.postDatatoSocketPLCWrite(staticTags.AUTORECIPEDOWNLOADRESULT_TAG, AutoRecipeUpgradeResult);

        } else if (!isAutoRecipeUpgradeResult && resetAutoRecipeUpgradeResultCount === feebackWriteCount) {
          log.error(`Error in Reset AutoRecipeUpgradeResult`);
          resetAutoRecipeUpgradeResultCount++;
          // after 3 times retry error in write reset values on PLC
          resetAutoRecipeUpgradeResultFlag = false;

        } else if (isAutoRecipeUpgradeResult) {
          // reset values written successfully on PLC
          resetAutoRecipeUpgradeResultFlag = false;
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