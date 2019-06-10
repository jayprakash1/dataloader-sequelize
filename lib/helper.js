'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.SEQUELIZE = exports.ASSOCIATION = exports.MODEL = undefined;
exports.methods = methods;
exports.method = method;
exports.type = type;

var _sequelize = require('sequelize');

var _sequelize2 = _interopRequireDefault(_sequelize);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const MODEL = exports.MODEL = 'MODEL';
const ASSOCIATION = exports.ASSOCIATION = 'ASSOCIATION';
const SEQUELIZE = exports.SEQUELIZE = 'SEQUELIZE';

function methods(version) {
  return {
    findByPk: /^[5]/.test(version) ? ['findByPk'] : /^[4]/.test(version) ? ['findByPk', 'findById'] : ['findById', 'findByPrimary']
  };
}

function method(target, alias) {
  if (type(target) === MODEL) {
    return methods(target.sequelize.constructor.version)[alias][0];
  }
  throw new Error('Unknown target');
}

function type(target) {
  if (target.associationType) {
    return ASSOCIATION;
  } else if (/(SequelizeModel|class extends Model)/.test(target.toString()) || _sequelize2.default.Model.isPrototypeOf(target)) {
    return MODEL;
  } else {
    return SEQUELIZE;
  }
}