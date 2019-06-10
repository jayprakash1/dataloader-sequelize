'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.EXPECTED_OPTIONS_KEY = undefined;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

exports.getCacheKey = getCacheKey;
exports.createContext = createContext;

var _sequelize = require('sequelize');

var _sequelize2 = _interopRequireDefault(_sequelize);

var _shimmer = require('shimmer');

var _shimmer2 = _interopRequireDefault(_shimmer);

var _dataloader = require('dataloader');

var _dataloader2 = _interopRequireDefault(_dataloader);

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

var _lodash = require('lodash');

var _lruCache = require('lru-cache');

var _lruCache2 = _interopRequireDefault(_lruCache);

var _assert = require('assert');

var _assert2 = _interopRequireDefault(_assert);

var _helper = require('./helper');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) arr2[i] = arr[i]; return arr2; } else { return Array.from(arr); } }

function mapResult(attribute, keys, options, result) {
  // Convert an array of results to an object of attribute (primary / foreign / target key) -> array of matching rows
  if (Array.isArray(attribute) && options && options.multiple && !options.raw) {
    // Regular belongs to many
    var _attribute = attribute,
        _attribute2 = _slicedToArray(_attribute, 2);

    let throughAttribute = _attribute2[0],
        foreignKey = _attribute2[1];

    result = result.reduce((carry, row) => {
      for (const throughRow of row.get(throughAttribute)) {
        let key = throughRow[foreignKey];
        if (!(key in carry)) {
          carry[key] = [];
        }

        carry[key].push(row);
      }

      return carry;
    }, {});
  } else {
    if (Array.isArray(attribute)) {
      // Belongs to many count is a raw query, so we have to get the attribute directly
      attribute = attribute.join('.');
    }
    result = (0, _lodash.groupBy)(result, (0, _lodash.property)(attribute));
  }

  return keys.map(key => {
    if (key in result) {
      let value = result[key];

      return options && options.multiple ? value : value[0];
    }
    return options && options.multiple ? [] : null;
  });
}

function stringifyValue(value, key) {
  // TODO: better way?? related to changes in graphql-sequelize so that findOptions have requestUser
  if (value && key === "requestUser") {
    return `${value.id}`;
  } else if (value && value.associationType) {
    return `${value.associationType},${value.target.name},${value.as}`;
  } else if (Array.isArray(value)) {
    if (key !== 'order') {
      // attribute order doesn't matter - order order definitely does
      value = (0, _lodash.clone)(value).sort();
    }
    return value.map(stringifyValue).join(',');
  } else if (typeof value === 'object' && value !== null) {
    if (value instanceof Date) return value.toJSON();
    return stringifyObject(value);
  }
  return value;
}

// This is basically a home-grown JSON.stringifier. However, JSON.stringify on objects
// depends on the order in which the properties were defined - which we don't like!
// Additionally, JSON.stringify escapes strings, which we don't need here
function stringifyObject(object) {
  let keys = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [].concat(_toConsumableArray(Object.keys(object)), _toConsumableArray(Object.getOwnPropertySymbols(object)));

  return keys.sort((lhs, rhs) => {
    const l = lhs.toString();
    const r = rhs.toString();
    if (l > r) return 1;
    if (l < r) return -1;
    return 0;
  }).map(key => `${key.toString()}:${stringifyValue(object[key], key)}`).join('|');
}

function getCacheKey(model, attribute, options) {
  // TODO: better way?? related to changes in graphql-sequelize so that findOptions have requestUser
  options = stringifyObject(options, ['association', 'attributes', 'groupedLimit', 'limit', 'offset', 'order', 'where', 'through', 'raw', 'requestUser', 'searchPath', 'paranoid']);

  let name = `${model.name}|${attribute}|${options}`;
  const schema = model.options && model.options.schema;
  if (schema) {
    name = `${schema}|${name}`;
  }
  return name;
}

function mergeWhere(where, optionsWhere) {
  if (optionsWhere) {
    return {
      [_sequelize2.default.Op ? _sequelize2.default.Op.and : '$and']: [where, optionsWhere]
    };
  }
  return where;
}

function rejectOnEmpty(options, result) {
  if ((0, _lodash.isEmpty)(result) && options.rejectOnEmpty) {
    if (typeof options.rejectOnEmpty === 'function') {
      throw new options.rejectOnEmpty();
    } else if (typeof options.rejectOnEmpty === 'object') {
      throw options.rejectOnEmpty;
    } else {
      throw new _sequelize2.default.EmptyResultError();
    }
  }

  return result;
}

function loaderForBTM(model, joinTableName, foreignKey, foreignKeyField) {
  let options = arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : {};

  (0, _assert2.default)(options.include === undefined, 'options.include is not supported by model loader');
  (0, _assert2.default)(options.association !== undefined, 'options.association should be set for BTM loader');

  let attributes = [joinTableName, foreignKey];
  const association = options.association;
  delete options.association;

  return new _dataloader2.default(keys => {
    let findOptions = Object.assign({}, options);
    delete findOptions.rejectOnEmpty;
    if (findOptions.limit) {
      const limit = findOptions.offset && findOptions.offset > 0 ? [findOptions.limit, findOptions.offset] : findOptions.limit;
      findOptions.groupedLimit = {
        through: options.through,
        on: association,
        limit: limit,
        values: (0, _lodash.uniq)(keys)
      };
    } else {
      findOptions.include = [{
        attributes: [foreignKey],
        association: association.manyFromSource,
        where: _extends({
          [foreignKeyField]: keys
        }, options.through.where)
      }];
    }

    return model.findAll(findOptions).then(mapResult.bind(null, attributes, keys, findOptions));
  }, {
    cache: options.cache
  });
}

function loaderForModel(model, attribute, attributeField) {
  let options = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : {};

  (0, _assert2.default)(options.include === undefined, 'options.include is not supported by model loader');

  return new _dataloader2.default(keys => {
    const findOptions = Object.assign({}, options);
    delete findOptions.rejectOnEmpty;

    if (findOptions.limit && keys.length > 1) {
      const limit = findOptions.offset && findOptions.offset > 0 ? [findOptions.limit, findOptions.offset] : findOptions.limit;
      findOptions.groupedLimit = {
        limit: limit,
        on: attributeField,
        values: (0, _lodash.uniq)(keys)
      };
      delete findOptions.limit;
      delete findOptions.offset;
    } else {
      findOptions.where = mergeWhere({
        [attributeField]: keys
      }, findOptions.where);
    }

    return model.findAll(findOptions).then(mapResult.bind(null, attribute, keys, options));
  }, {
    cache: options.cache
  });
}

function shimModel(target) {
  if (target.findByPk ? target.findByPk.__wrapped : target.findById.__wrapped) return;

  _shimmer2.default.massWrap(target, (0, _helper.methods)(_sequelize2.default.version).findByPk, original => {
    return function batchedFindById(id) {
      let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

      if ([null, undefined].indexOf(id) !== -1) {
        return _bluebird2.default.resolve(null);
      }
      if (options.transaction || options.include || activeClsTransaction() || !options[EXPECTED_OPTIONS_KEY]) {
        return original.apply(this, arguments);
      }

      const loader = options[EXPECTED_OPTIONS_KEY].loaders[this.name].byPrimaryKey;
      return _bluebird2.default.resolve(loader.load(id)).then(rejectOnEmpty.bind(null, options));
    };
  });
}

function shimBelongsTo(target) {
  if (target.get.__wrapped) return;

  _shimmer2.default.wrap(target, 'get', original => {
    return function batchedGetBelongsTo(instance) {
      let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

      if (Array.isArray(instance) || options.include || options.transaction || activeClsTransaction() || !options[EXPECTED_OPTIONS_KEY] || options.where) {
        return original.apply(this, arguments);
      }

      let foreignKeyValue = instance.get(this.foreignKey);
      return _bluebird2.default.resolve().then(() => {
        if (foreignKeyValue === undefined || foreignKeyValue === null) {
          return _bluebird2.default.resolve(null);
        }

        const loader = options[EXPECTED_OPTIONS_KEY].loaders[this.target.name].bySingleAttribute[this.targetKey];
        return _bluebird2.default.resolve(loader.load(foreignKeyValue));
      }).then(rejectOnEmpty.bind(null, options));
    };
  });
}

function shimHasOne(target) {
  if (target.get.__wrapped) return;

  _shimmer2.default.wrap(target, 'get', original => {
    return function batchedGetHasOne(instance) {
      let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

      if (Array.isArray(instance) || options.include || options.transaction || activeClsTransaction() || !options[EXPECTED_OPTIONS_KEY]) {
        return original.apply(this, arguments);
      }

      // TODO: very hacky way to allow access to request parameters in scope
      // related to changes "adding request user info" in forked graphql-sequelize repo
      if (this.scope) {
        let scope = this.scope;
        if (typeof scope === "function") {
          scope = scope(options, instance);
        }
        options.where = {
          $and: [options.where, scope]
        };
      }

      const loader = options[EXPECTED_OPTIONS_KEY].loaders[this.target.name].bySingleAttribute[this.foreignKey];
      return _bluebird2.default.resolve(loader.load(instance.get(this.sourceKey)).then(rejectOnEmpty.bind(null, options)));
    };
  });
}

function shimHasMany(target) {
  if (target.get.__wrapped) return;

  _shimmer2.default.wrap(target, 'get', original => {
    return function bathedGetHasMany(instances) {
      let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

      let isCount = false;
      if (options.include || options.transaction || options.separate || activeClsTransaction() || !options[EXPECTED_OPTIONS_KEY]) {
        return original.apply(this, arguments);
      }

      const attributes = options.attributes;
      if (attributes && attributes.length === 1 && attributes[0][0].fn && attributes[0][0].fn === 'COUNT' && !options.group) {
        // Phew, what an if statement - It avoids duplicating the count code from sequelize,
        // at the expense of slightly tighter coupling to the sequelize implementation
        options.attributes.push(this.foreignKey);
        options.multiple = false;
        options.group = [this.foreignKey];
        delete options.plain;
        isCount = true;
      }

      // TODO: very hacky way to allow access to request parameters in scope
      // related to changes "adding request user info" in forked graphql-sequelize repo
      // duplicating from hasOne
      if (this.scope) {
        let scope = this.scope;
        if (typeof scope === "function") {
          scope = scope(options, instances);
        }
        options.where = {
          [_sequelize2.default.Op ? _sequelize2.default.Op.and : '$and']: [options.where, scope]
        };
      }

      let loader = null,
          loaderOptions = _extends({
        multiple: true
      }, options);

      const cacheKey = getCacheKey(this.target, this.foreignKey, loaderOptions);
      loader = options[EXPECTED_OPTIONS_KEY].loaders.autogenerated.get(cacheKey);
      if (!loader) {
        loader = loaderForModel(this.target, this.foreignKey, this.foreignKeyField, _extends({}, loaderOptions, {
          cache: true
        }));
        options[EXPECTED_OPTIONS_KEY].loaders.autogenerated.set(cacheKey, loader);
      }

      let key = this.sourceKey || this.source.primaryKeyAttribute;

      if (Array.isArray(instances)) {
        return _bluebird2.default.map(instances, instance => {
          let sourceKeyValue = instance.get(key);

          if (sourceKeyValue === undefined || sourceKeyValue === null) {
            return _bluebird2.default.resolve(null);
          }

          return loader.load(sourceKeyValue);
        });
      } else {
        let sourceKeyValue = instances.get(key);

        if (sourceKeyValue === undefined || sourceKeyValue === null) {
          return _bluebird2.default.resolve(null);
        }

        return _bluebird2.default.resolve(loader.load(sourceKeyValue)).then(result => {
          if (isCount && !result) {
            result = { count: 0 };
          }
          return result;
        }).then(rejectOnEmpty.bind(null, options));
      }
    };
  });
}

function shimBelongsToMany(target) {
  if (target.get.__wrapped) return;

  _shimmer2.default.wrap(target, 'get', original => {
    return function bathedGetHasMany(instances) {
      let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

      let isCount = false;
      (0, _assert2.default)(this.paired, '.paired missing on belongsToMany association. You need to set up both sides of the association');

      if (options.include || options.transaction || activeClsTransaction() || !options[EXPECTED_OPTIONS_KEY]) {
        return original.apply(this, arguments);
      }

      const attributes = options.attributes;
      if (attributes && attributes.length === 1 && attributes[0][0].fn && attributes[0][0].fn === 'COUNT' && !options.group) {
        // Phew, what an if statement - It avoids duplicating the count code from sequelize,
        // at the expense of slightly tighter coupling to the sequelize implementation
        options.multiple = false;
        options.group = [`${this.paired.manyFromSource.as}.${this.identifierField}`];
        delete options.plain;
        isCount = true;
      }

      // TODO: very hacky way to allow access to request parameters in scope
      // related to changes "adding request user info" in forked graphql-sequelize repo
      // duplicating from hasOne
      if (this.scope) {
        let scope = this.scope;
        if (typeof scope === "function") {
          scope = scope(options, instances);
        }
        options.where = {
          [_sequelize2.default.Op ? _sequelize2.default.Op.and : '$and']: [options.where, scope]
        };
      }

      options.through = options.through || {};
      if (this.through.scope) {
        let scope = this.through.scope;
        // TODO: very hacky way to allow access to request parameters in scope
        // related to changes "adding request user info" in forked graphql-sequelize repo
        // duplicating from hasOne
        if (typeof scope === "function") {
          scope = scope(options, instances);
        }
        options.through.where = {
          [_sequelize2.default.Op ? _sequelize2.default.Op.and : '$and']: [options.through.where, scope]
        };
      }

      let loader,
          loaderOptions = _extends({
        association: this.paired,
        multiple: true
      }, options);

      const cacheKey = getCacheKey(this.target, [this.paired.manyFromSource.as, this.foreignKey], loaderOptions);
      loader = options[EXPECTED_OPTIONS_KEY].loaders.autogenerated.get(cacheKey);
      if (!loader) {
        loader = loaderForBTM(this.target, this.paired.manyFromSource.as, this.foreignKey, this.identifierField, _extends({}, loaderOptions, {
          cache: true
        }));
        options[EXPECTED_OPTIONS_KEY].loaders.autogenerated.set(cacheKey, loader);
      }

      if (Array.isArray(instances)) {
        return _bluebird2.default.map(instances, instance => loader.load(instance.get(this.source.primaryKeyAttribute)));
      } else {
        return _bluebird2.default.resolve(loader.load(instances.get(this.source.primaryKeyAttribute))).then(result => {
          if (isCount && !result) {
            result = { count: 0 };
          }
          return result;
        }).then(rejectOnEmpty.bind(null, options));
      }
    };
  });
}

function activeClsTransaction() {
  if (/^[45]/.test(_sequelize2.default.version)) {
    if (_sequelize2.default._cls && _sequelize2.default._cls.get('transaction')) {
      return true;
    }
  } else if (_sequelize2.default.cls && _sequelize2.default.cls.get('transaction')) {
    return true;
  }
  return false;
}

const EXPECTED_OPTIONS_KEY = exports.EXPECTED_OPTIONS_KEY = 'dataloader_sequelize_context';
function createContext(sequelize) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

  const loaders = {};

  shimModel(/^[45]/.test(sequelize.constructor.version) ? // v3 vs v4
  sequelize.constructor.Model : sequelize.constructor.Model.prototype);
  shimBelongsTo(sequelize.constructor.Association.BelongsTo.prototype);
  shimHasOne(sequelize.constructor.Association.HasOne.prototype);
  shimHasMany(sequelize.constructor.Association.HasMany.prototype);
  shimBelongsToMany(sequelize.constructor.Association.BelongsToMany.prototype);

  loaders.autogenerated = (0, _lruCache2.default)({ max: options.max || 500 });

  sequelize.modelManager.forEachModel(Model => {
    loaders[Model.name] = {
      bySingleAttribute: {}
    };
    loaders[Model.name].bySingleAttribute[Model.primaryKeyAttribute] = createModelAttributeLoader(Model, Model.primaryKeyAttribute, options);
    loaders[Model.name].byId = loaders[Model.name].byPrimaryKey = loaders[Model.name].bySingleAttribute[Model.primaryKeyAttribute];
  });

  sequelize.modelManager.forEachModel(Model => {
    (0, _lodash.values)(Model.associations).forEach(association => {
      if (association.associationType === 'BelongsTo') {
        const Target = association.target;
        if (association.targetKey !== Target.primaryKeyAttribute) {
          loaders[Target.name].bySingleAttribute[association.targetKey] = createModelAttributeLoader(Target, association.targetKey, options);
        }
      } else if (association.associationType === 'HasOne') {
        const Target = association.target;
        loaders[Target.name].bySingleAttribute[association.foreignKey] = createModelAttributeLoader(Target, association.foreignKey, options);
      }
    });
  });

  function prime(results) {
    if (!Array.isArray(results)) {
      results = [results];
    }

    results.forEach(result => {
      const modelName = result.Model ? result.Model.name : result.constructor.name;
      Object.keys(loaders[modelName].bySingleAttribute).forEach(attribute => {
        loaders[modelName].bySingleAttribute[attribute].prime(result.get(attribute), result);
      });
    });
  }

  return { loaders: loaders, prime: prime };
}

function createModelAttributeLoader(Model, attribute) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

  return new _dataloader2.default(keys => {
    return Model.findAll({
      where: {
        [attribute]: keys
      },
      logging: options.logging
    }).then(mapResult.bind(null, attribute, keys, {}));
  }, {
    cache: true
  });
}