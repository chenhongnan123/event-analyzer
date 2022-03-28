const NodePackage = require('./nodepackage.service').NodePackage;
const bunyan = NodePackage.bunyan;
const axios = NodePackage.axios;
const moment = NodePackage.moment;
const messerver = NodePackage.messerver;

class InterfaceService {
  constructor() {
    this.url = `${messerver.protocol}://${messerver.host}/Execjson.aspx`;
    this.log = bunyan.createLogger({ name: `Checkout_${substationid}`, level: config.logger.loglevel });
  }
  commitProductionData(payload) {
    const data = {
      ...payload,
      "agreement": "ma_receive_list",
      "tranid": moment().format('YYYYMMDDHHmmssSSS'),
      "time": moment().format('YYYYMMDDHHmmssSSS'),
      "dsid": "1066",
      "fromdsid": "8006",
    };
    return axios.post(`${this.url}`, data, {
     //timeout: 10000,
    });
  }
  commitPartNG(payload) {
    const data = {
      head: payload,
      "agreement": "ma_part_offline",
      "tranid": moment().format('YYYYMMDDHHmmssSSS'),
      "time": moment().format('YYYYMMDDHHmmssSSS'),
      "dsid": "1066",
      "fromdsid": "8006",
      "body": []
    };
    return axios.post(`${this.url}`, data, {
      timeout: 10000,
    });
  }
  getBom(payload) {
    const data = {
      "agreement": "ma_send_bom",
      "tranid": moment().format('YYYYMMDDHHmmssSSS'),
      "time": moment().format('YYYYMMDDHHmmssSSS'),
      "dsid": "1066",
      "fromdsid": "8006",
      head: payload,
      "body": []
    };
    return axios.post(`${this.url}`, data, {
      timeout: 10000,
    });
  }
  getRecipe(payload) {
    const data = {
      "agreement": "ma_send_para",
      "tranid": moment().format('YYYYMMDDHHmmssSSS'),
      "time": moment().format('YYYYMMDDHHmmssSSS'),
      "dsid": "1066",
      "fromdsid": "8006",
      head: payload,
      "body": []
    };
    return axios.post(`${this.url}`, data, {
      timeout: 10000,
    });
  }
  getRework(payload) {
    const data = {
      "agreement": "ma_part_rework",
      "tranid": moment().format('YYYYMMDDHHmmssSSS'),
      "time": moment().format('YYYYMMDDHHmmssSSS'),
      "dsid": "1066",
      "fromdsid": "8006",
      head: payload,
      "body": []
    };console.log(`Rework:${JSON.stringify(data)}`)
    return axios.post(`${this.url}`, data, {
      timeout: 10000,
    });
  }
  commitState(payload) {
    const data = {
      "agreement": "ma_wc_up",
      "tranid": moment().format('YYYYMMDDHHmmssSSS'),
      "time": moment().format('YYYYMMDDHHmmssSSS'),
      "dsid": "1066",
      "fromdsid": "8006",
      head: {},
      "body": payload
    };
    return axios.post(`${this.url}`, data, {
      timeout: 10000,
    });
  }
};

module.exports.InterfaceService = new InterfaceService();
