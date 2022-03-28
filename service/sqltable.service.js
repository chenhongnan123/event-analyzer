const apiService = require('./api.service');
const ApiService = apiService.ApiService;

class SQLTableService {
  constructor() {
    this.request = ApiService;
  }
  getSQLTableRecords(tableName){
    return this.request.get(`/server/${tableName}?${ApiService.customerInfo}`);
  }
}
module.exports.SQLTableService = new SQLTableService();
