const apiService = require('./api.service');
const ApiService = apiService.ApiService;

class ServertimeService {
  constructor() {
    this.request = ApiService;
  }

  getServerTime(data) {
    return this.request.get('/server/servertime', data);
  }

}

module.exports.ServertimeService = new ServertimeService();
