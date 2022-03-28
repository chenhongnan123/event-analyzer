
'use strict'
module.exports.order = order;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
const socketService = require('../service/socket.service').SocketService;

function order(config, substation, utility, tags, MESSAGESCODE, emitter) {
    const substationTags = tags.substationtags;
    const orderdetailsTags = tags.orderdetailstags;
    const orderproductTags = tags.orderproducttags;
    const staticTags = tags.statictags;
    const bomdetialsTags = tags.bomdetialsTags;
    const parameterTags = tags.parametertags;
    const elements = config.elements;
    const status = config.status;
    const defaults = config.defaults;
    const socketio = config.feedbacktoplcsocketio;

    let lineid = substation[substationTags.LINEID_TAG];
    let sublineid = substation[substationTags.SUBLINEID_TAG];
    let stationname = substation[substationTags.NAME_TAG];
    let substationid = substation[substationTags.SUBSTATIONID_TAG];
    let retryServerTimer = defaults.retryServerTimer || 10;
    const maxServerRetryCount = defaults.maxServerRetryCount;
    const retryToPLCTimer = defaults.retryToPLCTimer; // in milliseconds
    const log = bunyan.createLogger({ name: `Order_${substationid}`, level: config.logger.loglevel });

    return {
        runningOrder: [],
        /**
         * Multiple Order
         * runningOrder = [
         *  {
         *  orderProduct: [],
         *   runningRecipe: [],
          *  runningRoadMap: [],
          *  bomDetailsQualityStatusForQ : [],
          *  bomDetailsQualityStatusForS : [],
          *  bomDetailsComponentForQ : [],
          *  bomDetailsComponentForS : [],
          *  targetSubStation: [],
         * ordercount: 0,
         *  },
         * ]
        */
        // orderProduct: [],
        // runningRecipe: [],
        // runningRoadMap: [],
        // bomDetailsQualityStatusForQ : [],
        // bomDetailsQualityStatusForS : [],
        // bomDetailsComponentForQ : [],
        // bomDetailsComponentForS : [],
        // targetSubStation: [],
        // ordercount: 0,
        /**
         * Intialize the socket listener on startup of E.A.
         */
        initEmitter() {
            /**
             * Order update Event received from ShopWorx
             * One line has one Order running at a time
             */
            emitter.on('order', (data) => {
                log.info(`Order event triggered ${JSON.stringify(data)}`);
                this.getOrder();
            })

        },
        processStationData(data1) {
            let data = utility.cloneDeep(data1);
            let removePrefix = 'q_';
            let removeParameter = 's_';
            data = utility.modifyObject(data, removePrefix, removeParameter);
            this.CheckOrderFeedbacktoPLC(data);
        },
        /**
         * This method check recipe written on PLC. If not then retry for configurable number of count
         * @param {Object} data 
         */
        CheckOrderFeedbacktoPLC(data) {
            // check Order
            if (this.writeOrderisrunningFlag) {
                // if virtualMainId value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = this.orderisrunning === data[staticTags.RECIPENAMEFEEDBACK_TAG] ? true : false;
                if (!isValid && this.OrderisrunningCount < feebackWriteCount) {
                    clearTimeout(this.OrderisrunningTimer);
                    this.writeOrderisrunningFlag = false;
                    // plc polling is reduced to 50 ms
                    this.OrderisrunningTimer = setTimeout(() => {
                        this.writeOrderisrunningFlag = true;
                    }, retryToPLCTimer);
                    this.OrderisrunningCount++;
                    this.postDatatoSocketPLCWrite(staticTags.RECIPENAMEFEEDBACK_TAG, this.orderisrunning);

                } else if (!isValid && this.OrderisrunningCount === feebackWriteCount) {
                    log.error(`Error in write value of Orderisrunning to PLC after max retry ${feebackWriteCount}`);
                    this.writeOrderisrunningFlag = false;
                } else if (isValid) {
                    // if all ok then stop validation
                    this.writeOrderisrunningFlag = false;
                }
            }
        },
        /**
         * This method get the currently running Order information
         * For Line MES only one Order running at a time
         * @param {Object} data 
         */
        async getOrder() {

            const elementName = elements.order || 'order';
            try {
                /*
                    query = `query=lineid==1%26%26orderstatus=="running"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
                */
                let query = `query=${[orderdetailsTags.LINEID_TAG]}==${lineid}%26%26${[orderdetailsTags.ORDERSTATUS_TAG]}=="${status.running}"`;
                query += `&sortquery=createdTimestamp==-1`;
                log.error(`Order Query ${query}`);
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`Order fetched successfully`);
                        let results = response.data.results;
                        results = results.map(item => {
                            delete item.createdTimestamp;
                            delete item.modifiedtimestamp;
                            delete item._id;
                            return item;
                        });
                        this.runningOrder = results.map((item) => {
                            return {
                                orderdata: item,
                            }
                        });
                        this.runningOrder.forEach((order) => {
                            this.getOrderProduct(order);
                            this.getOrderCount(order);
                        })
                        // write productname
                        this.orderisrunning = results[0][orderdetailsTags["PRODUCTTYPENAME_TAG"]];
                        if (substation[substationTags.INITIALSUBSTATION_TAG]) {
                            this.writeOrderisrunningFlag = true;
                            this.OrderisrunningCount = 0;
                            this.postDatatoSocketPLCWrite(staticTags.RECIPENAMEFEEDBACK_TAG, this.orderisrunning);
                        }
                    } else {
                        log.error(`Running Order not found  ${JSON.stringify(response.data)}`);
                        this.runningOrder = [];
                        // order.orderProduct = [];
                        // order.runningRecipe = [];
                        // order.runningRoadMap = [];
                        // order.bomDetailsQualityStatusForQ = []
                        // order.bomDetailsQualityStatusForS = []
                        // order.bomDetailsComponentForQ = []
                        //order.bomDetailsComponentForS = []
                        // write productname

                        this.orderisrunning = '';
                        if (substation[substationTags.INITIALSUBSTATION_TAG]) {
                            this.writeOrderisrunningFlag = true;
                            this.OrderisrunningCount = 0;
                            this.postDatatoSocketPLCWrite(staticTags.RECIPENAMEFEEDBACK_TAG, this.orderisrunning);
                        }

                    }
                } else {
                    log.error(`Error in getting data for order : ${elementName} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    await this.getOrder();
                }
            } catch (ex) {
                log.error(`Exception to fetch data for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                await this.getOrder();
            }
        },
        /**
         * This method get the currently running Order information
         * For Line MES only one Order running at a time
         * @param {Object} data 
         * @param {Int} counter 
         */
        async getOrderProduct(order, counter) {
            const { orderdata } = order;
            if (!counter) {
                counter = 0;
            }
            const elementName = elements.orderproduct || 'orderproduct';
            try {
                /*
                    query = `query=lineid==1%26%26sublineid=="subline-1"%26%26substationid=="substation-1"%26%26orderid=="order-1"`
                */
                let query = `query=${[orderproductTags.LINEID_TAG]}==${lineid}%26%26${[orderproductTags.SUBLINEID_TAG]}=="${sublineid}"%26%26${[orderproductTags.SUBSTATIONID_TAG]}=="${substationid}"%26%26${[orderproductTags.ORDERID_TAG]}=="${orderdata[orderdetailsTags.ORDERNUMBER_TAG]}"`;
                query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                log.error(`OrderProduct query : ${query}`);
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`Order Product fetched successfully`);
                        order.orderProduct = response.data.results;
                        const result = response.data.results[0];
                        if (orderdata[orderdetailsTags.BOMID_TAG]) {
                            this.getBomDetailsForComponent(order);
                            this.getBomDetailsForQualityStatus(order);
                        } else {
                            log.error(`Bomid not present in Order Details : ${orderdata[orderdetailsTags.ORDERNUMBER_TAG]}`)
                            order.bomDetailsComponentForQ = []
                            order.bomDetailsComponentForS = []
                        }
                        if (result[orderproductTags.ORDERID_TAG] && result[orderproductTags.RECIPENUMBER_TAG]) {
                            this.getOrderRecipe(order);
                        } else {
                            log.error(`Order Recipe Id not found in OrderProduct`);
                            order.runningRecipe = [];
                        }
                        if (orderdata[orderdetailsTags.ORDERNUMBER_TAG] && orderdata[orderdetailsTags.ROADMAPID_TAG]) {
                            this.getOrderRoadmap(order);
                        } else {
                            log.error(`Order Roadmap Id not found in Order`);
                            order.runningRoadMap = [];
                            order.targetSubStation = [];
                        }
                    } else {
                        log.error(`Order Product not found  ${JSON.stringify(response.data)}`);
                        // TODO what we will write to PLC for recipe if order not found
                        order.orderProduct = [];
                        order.runningRecipe = [];
                        order.runningRoadMap = [];
                        order.bomDetailsQualityStatusForQ = []
                        order.bomDetailsQualityStatusForS = []
                        order.bomDetailsComponentForQ = []
                        order.bomDetailsComponentForS = []
                        order.targetSubStation = [];
                    }
                } else {
                    log.error(`Error in getting data of Order Product Recipe for order numebr : ${orderdata[orderdetailsTags.ORDERNUMBER_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    if (counter <= maxServerRetryCount) {
                        counter++;
                        await this.getOrderProduct(order, counter);
                    }
                }
            } catch (ex) {
                log.error(`Exception to fetch data for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                if (counter <= maxServerRetryCount) {
                    counter++;
                    await this.getOrderProduct(order, counter);
                }
            }
        },
        /**
         * This method get the currently running Order information
         * For Line MES only one Order running at a time
         * @param {Object} data 
         * @param {Int} counter 
         */
        async getOrderRecipe(order, counter) {
            const orderProduct = order.orderProduct[0];
            const recipeTags = tags.recipedetailstags;
            if (!counter) {
                counter = 0;
            }
            const elementName = elements.orderrecipe || 'orderrecipe';
            try {
                /*
                    query = `lineid=="line-1"%26%26lineid=="line-1"%26%26sublineid=="sublineid-1"%26%26substationid=="substationid-1"%26%26orderid=="order-1"%26%26recipeid=="recipe-1"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
                */
                let query = `query=${[recipeTags.LINEID_TAG]}==${lineid}%26%26${[recipeTags.SUBLINEID_TAG]}=="${sublineid}"%26%26${[recipeTags.SUBSTATIONID_TAG]}=="${substationid}"%26%26${[recipeTags.ORDERID_TAG]}=="${orderProduct[orderproductTags.ORDERID_TAG]}"%26%26${[recipeTags.RECIPEID_TAG]}=="${orderProduct[orderproductTags.RECIPENUMBER_TAG]}"`;
                query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                log.error(`OrderRecipe query : ${query}`);
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`Order Recipe fetched successfully`);
                        order.runningRecipe = response.data.results;
                    } else {
                        log.error(`Order Recipe not found  ${JSON.stringify(response.data)}`);
                        order.runningRecipe = [];
                        // TODO what we will write to PLC for recipe if order not found
                    }
                } else {
                    log.error(`Error in getting data of Order Recipe for order numebr : ${orderProduct[orderdetailsTags.ORDERID_TAG]} ${orderProduct[orderdetailsTags.RECIPENUMBER_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    if (counter <= maxServerRetryCount) {
                        counter++;
                        await this.getOrderRecipe(order, counter);
                    }
                }
            } catch (ex) {
                log.error(`Exception to fetch data for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                if (counter <= maxServerRetryCount) {
                    counter++;
                    await this.getOrderRecipe(order, counter);
                }
            }
        },
        /**
         * This method get the currently running Order information
         * For Line MES only one Order running at a time
         * @param {Object} data 
         * @param {Int} counter 
         */
        // TODO assignement
        async getOrderRoadmap(order, counter) {
            const { orderdata } = order;

            const roadmapTags = tags.roadmaptags;
            if (!counter) {
                counter = 0;
            }
            const elementName = elements.orderroadmap || 'orderroadmap';
            try {
                /*
                    query = `query=lineid==1%26%26sublineid=="subline-1"%26%26substationid=="substation-1"%26%26orderid=="order-1"%26%26roadmapid=="roadmap-1"`
                */
                let query = `query=${[roadmapTags.LINEID_TAG]}==${lineid}%26%26${[roadmapTags.SUBLINEID_TAG]}=="${sublineid}"%26%26${[roadmapTags.SUBSTATIONID_TAG]}=="${substationid}"%26%26${[roadmapTags.ORDERID_TAG]}=="${orderdata[orderdetailsTags.ORDERNUMBER_TAG]}"%26%26${[roadmapTags.ROADMAPID_TAG]}=="${orderdata[orderdetailsTags.ROADMAPID_TAG]}"`;
                log.error(`OrderRoadmap query : ${query}`);
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`Order Roadmap fetched successfully`);
                        order.runningRoadMap = response.data.results;
                    } else {
                        log.error(`Order Roadmap not found  ${JSON.stringify(response.data)}`);
                        order.runningRoadMap = [];
                        order.targetSubStation = [];
                        // TODO what we will write to PLC for roadmap if order not found
                    }
                } else {
                    log.error(`Error in getting data of Order Roadmap for order numebr : ${orderdata[orderdetailsTags.ORDERNUMBER_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    if (counter <= maxServerRetryCount) {
                        counter++;
                        await this.getOrderRoadmap(order, counter);
                    }
                }
            } catch (ex) {
                log.error(`Exception to fetch data for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                if (counter <= maxServerRetryCount) {
                    counter++;
                    await this.getOrderRoadmap(order, counter);
                }
            }
        },
        /**
        * This method get the bomdetails of running Order information
        * For Line MES only one Order running at a time
        * @param {Object} data 
        * @param {Int} counter 
        */
        async getBomDetailsForComponent(order, counter) {
            const { orderdata } = order;

            if (!counter) {
                counter = 0;
            }
            const elementName = elements.bomdetailsconfig || 'bomdetailsconfig';
            try {
                let query = `query=${[bomdetialsTags.SUBSTATIONID_TAG]}=="${substationid}"%26%26${[bomdetialsTags.BOMID_TAG]}==${orderdata[bomdetialsTags.BOMID_TAG]}`;
                log.error(`Bom Details for component query : ${query}`);
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`Bom Details for component fetched successfully`);
                        order.bomDetailsComponentForQ = this.createComponentRecordsForQ(response.data.results[0]);
                        order.bomDetailsComponentForS = this.createComponentRecordsForS(response.data.results[0]);
                    } else {
                        log.error(`Bom Details for component not found  ${JSON.stringify(response.data)}`);
                        order.bomDetailsComponentForQ = [];
                        order.bomDetailsComponentForS = [];
                    }
                } else {
                    log.error(`Error in getting data of Bom Details for component for order numebr : ${orderdata[bomdetialsTags.BOMID_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    if (counter <= maxServerRetryCount) {
                        counter++;
                        await this.getBomDetailsForComponent(order, counter);
                    }
                }
            } catch (ex) {
                log.error(`Exception to fetch Bom Details for component for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                if (counter <= maxServerRetryCount) {
                    counter++;
                    await this.getBomDetailsForComponent(order, counter);
                }
            }
        },
        /**
        * This method get the bomdetails of running Order information
        * For Line MES only one Order running at a time
        * @param {Object} data 
        * @param {Int} counter 
        */
        async getBomDetailsForQualityStatus(order, counter) {
            const { orderdata } = order;

            if (!counter) {
                counter = 0;
            }
            const elementName = elements.bomdetailsconfig || 'bomdetailsconfig';
            try {
                let query = `query=${[bomdetialsTags.SUBSTATIONID_TAG]}=="${substationid}"%26%26${[bomdetialsTags.BOMID_TAG]}==${orderdata[bomdetialsTags.BOMID_TAG]}`;
                log.error(`Bom Details for Qaulity Status query : ${query}`);
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`Bom Details for Qaulity Status fetched successfully`);
                        order.bomDetailsQualityStatusForQ = this.createComponentRecordsForQ(response.data.results[0]);
                        order.bomDetailsQualityStatusForS = this.createComponentRecordsForS(response.data.results[0]);
                    } else {
                        log.error(`Bom Details for Qaulity Status not found  ${JSON.stringify(response.data)}`);
                        order.bomDetailsQualityStatusForQ = []
                        order.bomDetailsQualityStatusForS = []
                    }
                } else {
                    log.error(`Error in getting data of Bom Details for Qaulity Status for order numebr : ${orderdata[bomdetialsTags.BOMID_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    if (counter <= maxServerRetryCount) {
                        counter++;
                        await this.getBomDetailsForQualityStatus(order, counter);
                    }
                }
            } catch (ex) {
                log.error(`Exception to fetch Bom Details for Qaulity Status for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                if (counter <= maxServerRetryCount) {
                    counter++;
                    await this.getBomDetailsForQualityStatus(order, counter);
                }
            }
        },
        /**
        * This method get the bomdetails of running Order information
        * For Line MES only one Order running at a time
        * @param {Object} data 
        * @param {Int} counter 
        */
        async getTargetSubStations(order, counter) {
            const { orderdata } = order;
            const roadmapTags = tags.roadmaptags;
            if (!counter) {
                counter = 0;
            }
            const elementName = elements.orderroadmap || 'orderroadmap';
            try {
                /*
                    query = `query=lineid==1%26%26sublineid=="subline-1"%26%26presubstationid=="substation-1"%26%26orderid=="order-1"%26%26roadmapid=="roadmap-1"`
                */
                let query = `query=${[roadmapTags.LINEID_TAG]}==${lineid}%26%26${[roadmapTags.SUBLINEID_TAG]}=="${sublineid}"%26%26${[roadmapTags.PRESUBSTATIONID_TAG]}=="${substationid}"%26%26${[roadmapTags.ORDERID_TAG]}=="${orderdata[orderdetailsTags.ORDERNUMBER_TAG]}"%26%26${[roadmapTags.ROADMAPID_TAG]}=="${orderdata[orderdetailsTags.ROADMAPID_TAG]}"`;
                log.error(`OrderRoadmap query : ${query}`);
debugger;
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`targetSubStation fetched successfully`);
                        order.targetSubStation = response.data.results;
                    } else {
debugger;
                        log.error(`targetSubStation not found  ${JSON.stringify(response.data)}`);
                        order.targetSubStation = [];
                    }
                } else {
                    log.error(`Error in getting data of targetSubStation for order numebr : ${orderdata[orderdetailsTags.ROADMAPID_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    if (counter <= maxServerRetryCount) {
                        counter++;
                        await this.getTargetSubStations(orderdata, counter);
                    }
                }
            } catch (ex) {
                log.error(`Exception to fetch targetSubStation for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                if (counter <= maxServerRetryCount) {
                    counter++;
                    await this.getTargetSubStations(orderdata, counter);
                }
            }
        },
        /**
         * This method get the order count from ordercount element
         * @param {Object} orderdata 
         */
        async getOrderCount(order) {
            const { orderdata } = order;
            const elementName = elements.ordercount || 'ordercount';
            try {
                /*
                    query = `query=lineid==1%26%26orderid=="order-1"`
                */
                let query = `query=${[orderdetailsTags.LINEID_TAG]}==${lineid}%26%26${orderdetailsTags.ORDERNUMBER_TAG}=="${orderdata[orderdetailsTags.ORDERNUMBER_TAG]}"`;
                query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                log.error(`Order Count query : ${query}`);
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`Order Count fetched successfully`);
                        const result = response.data.results[0];
                        order.ordercount = result.ordercount;
                    } else {
                        log.error(`Order Count not found  ${JSON.stringify(response.data)}`);
                        order.ordercount = 0;
                    }
                } else {
                    log.error(`Error in getting data of Order Product Recipe for order numebr : ${orderdata[orderdetailsTags.ORDERNUMBER_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                }
            } catch (ex) {
                log.error(`Exception to fetch data for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
            }
        },
        /**
         * This method get the roadmap for rework part
         * @param {Object} data 
         */
        async getRoadMapForRework(data) {
            const roadmapTags = tags.roadmaptags;
            const elementName = elements.roadmapdetails || 'roadmapdetails';
            try {
                /*
                    query = `query=lineid==1%26%26sublineid=="subline-1"%26%26substationid=="substation-1"%26%26roadmapid=="roadmap-1"`
                */
                let query = `query=${[roadmapTags.LINEID_TAG]}==${lineid}%26%26${[roadmapTags.SUBLINEID_TAG]}=="${sublineid}"%26%26${[roadmapTags.SUBSTATIONID_TAG]}=="${substationid}"%26%26${[roadmapTags.ROADMAPID_TAG]}=="${data[roadmapTags.ROADMAPID_TAG]}"`;
                log.error(`ReworkRoadmap query : ${query}`);
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`ReworkRoadmap fetched successfully`);
                        return response.data.results;
                    } else {
                        log.error(`targetSubStation not found  ${JSON.stringify(response.data)}`);
                        return [];
                    }
                } else {
                    log.error(`Error in getting data of ReworkRoadmap for order numebr : ${data[orderdetailsTags.ROADMAPID_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    return [];
                }
            } catch (ex) {
                log.error(`Exception to fetch ReworkRoadmap for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                return [];
            }
        },
        /**
        * This method get the bomdetails of running Order information
        * For Line MES only one Order running at a time
        * @param {Object} data 
        */
        async getTargetSubStationForSubstation(roadmapid, substationID) {
            const roadmapTags = tags.roadmaptags;
            const elementName = elements.roadmapdetails || 'roadmapdetails';
            try {
                /*
                    query = `query=lineid==1%26%26sublineid=="subline-1"%26%26presubstationid=="substation-1"%26%26orderid=="order-1"%26%26roadmapid=="roadmap-1"`
                */
                let query = '';
                if (substationID) {
                    query = `query=${[roadmapTags.LINEID_TAG]}==${lineid}%26%26${[roadmapTags.SUBLINEID_TAG]}=="${sublineid}"%26%26${[roadmapTags.PRESUBSTATIONID_TAG]}=="${substationID}"%26%26${[roadmapTags.ROADMAPID_TAG]}=="${roadmapid}"`;
                    log.error(`OrderRoadmap query with substationid in partstatus record  : ${query}`);
                } else {
                    // no substationid present in partstatus
                    query = `query=${[roadmapTags.LINEID_TAG]}==${lineid}%26%26${[roadmapTags.SUBLINEID_TAG]}=="${sublineid}"%26%26${[roadmapTags.ROADMAPID_TAG]}=="${roadmapid}"`;
                    log.error(`OrderRoadmap query without substationid in partstatus record : ${query}`);
                }
                query += `&sortquery=createdTimestamp==1`
                this.targetSubStationRework = [];
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        log.error(`targetSubStation fetched successfully`);
                        return response.data.results;
                    } else {
                        log.error(`targetSubStation not found  ${JSON.stringify(response.data)}`);
                        return [];
                    }
                } else {
                    log.error(`Error in getting data of targetSubStation for order numebr : ${orderProduct[orderdetailsTags.ROADMAPID_TAG]} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    return [];
                }
            } catch (ex) {
                log.error(`Exception to fetch targetSubStation for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                return [];
            }
        },
        /**
         * create multiple records from 1 record of bomdetails from bomdetailsconfig element record
         * @param {*} bomrecord 
         */
        createComponentRecordsForS(bomrecord) {
            bomrecord = utility.cloneDeep(bomrecord);
            // create multiple records from 1 record of bomdetails
            let bomDetailsArray = [];
            for (var i = 0; i < bomrecord.parameterlist.length; i++) {
                let obj = bomrecord.parameterlist[i];
                // TODO remove prefix
                let checkPrefix = 's_';
                let paramname = obj[parameterTags.PARAMETERNAME_TAG];
                let paramname1 = obj[parameterTags.PARAMETERNAME_TAG];
                // include only component with prefix s_
                if (paramname.includes(checkPrefix)) {
                    paramname = paramname.split(checkPrefix)[1];
                    let qualityStatusKey = `qualitystatus_component_${paramname1}`
                    let componentStatusKey = `componentstatus_component_${paramname1}`
                    let saveDataKey = `savedata_component_${paramname1}`
                    obj[bomdetialsTags.PARAMETERNAME_TAG] = paramname;
                    obj[bomdetialsTags.QUALITYSTATUS_TAG] = bomrecord[qualityStatusKey];
                    obj[bomdetialsTags.COMPONENTSTATUS_TAG] = bomrecord[componentStatusKey];
                    obj[bomdetialsTags.SAVEDATA_TAG] = bomrecord[saveDataKey];
                    bomDetailsArray.push(obj);
                }
            }
            return bomDetailsArray;
        },
        /**
         * create multiple records from 1 record of bomdetails from bomdetailsconfig element record
         * @param {*} bomrecord 
         */
        createComponentRecordsForQ(bomrecord) {
            // create multiple records from 1 record of bomdetails
            bomrecord = utility.cloneDeep(bomrecord);
            let bomDetailsArray = [];
            for (var i = 0; i < bomrecord.parameterlist.length; i++) {
                let obj = bomrecord.parameterlist[i];
                // TODO remove prefix
                let checkPrefix = 'q_';
                let paramname = obj[parameterTags.PARAMETERNAME_TAG];
                let paramname1 = obj[parameterTags.PARAMETERNAME_TAG];
                // include only component with prefix q_
                if (paramname.includes(checkPrefix)) {
                    paramname = paramname.split(checkPrefix)[1];
                    let qualityStatusKey = `qualitystatus_component_${paramname1}`
                    let componentStatusKey = `componentstatus_component_${paramname1}`
                    let saveDataKey = `savedata_component_${paramname1}`
                    obj[bomdetialsTags.PARAMETERNAME_TAG] = paramname;
                    obj[bomdetialsTags.QUALITYSTATUS_TAG] = bomrecord[qualityStatusKey];
                    obj[bomdetialsTags.COMPONENTSTATUS_TAG] = bomrecord[componentStatusKey];
                    obj[bomdetialsTags.SAVEDATA_TAG] = bomrecord[saveDataKey];
                    bomDetailsArray.push(obj);
                }
            }
            return bomDetailsArray;
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
