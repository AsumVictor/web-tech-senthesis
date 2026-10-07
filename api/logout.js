const { handleApi } = require("../lib/canvas");

module.exports = (req, res) => handleApi(req, res, "/api/logout");
