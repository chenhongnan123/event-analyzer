const apiService = require('./api.service');
const ApiService = apiService.ApiService;

class ShiftService {
  constructor() {
    this.request = ApiService;
  }

  getShiftForTimestamp(timestamp) {
    return this.request.get(`/server/shiftfortimestamp/${timestamp}`);
  }

  getAllShifts() {
    return this.request.get(`/server/shifts`);
  }

}

module.exports.ShiftService = new ShiftService();
