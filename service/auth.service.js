const apiService = require('./api.service');
const ApiService = apiService.ApiService;

class AuthService {
  constructor() {
    this.request = ApiService;
  }

  authenticate(data) {
    return this.request.post('/server/authenticate', data);
  }

  authenticateWithOtp(data) {
    return this.request.post('/server/authenticatewithotp', data);
  }

  generateOtp(data) {
    return this.request.post('/server/otp/generate', data);
  }

  resetPassword(data) {
    return this.request.post('/server/users/resetuserpassword', data);
  }

  logout() {
    return this.request.get('/server/logout');
  }
}
module.exports.AuthService = new AuthService();

