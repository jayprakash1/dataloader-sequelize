import Sequelize from 'sequelize';
import shimmer from 'shimmer';
import DataLoader from 'dataloader';
import Promise from 'bluebird';
import {groupBy, property, values, clone, isEmpty} from 'lodash';
import LRU from 'lru-cache';
import assert from 'assert';
import {methods} from './helper';

function mapResult(attribute, keys, options, result) {
  // Convert an array of results to an object of attribute (primary / foreign / target key) -> array of matching rows
  if (Array.isArray(attribute) && options.multiple && !options.raw) {
    // Regular belongs to many
    let [throughAttribute, foreignKey] = attribute;
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
    result = groupBy(result, property(attribute));
  }

  return keys.map(key => {
    if (key in result) {
      let value = result[key];

      return options.multiple ? value : value[0];
    }
    return options.multiple ? [] : null;
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
      value = clone(value).sort();
    }
    return value.map(stringifyValue).join(',');
  } else if (typeof value === 'object' && value !== null) {
    return stringifyObject(value);
  }
  return value;
}

// This is basically a home-grown JSON.stringifier. However, JSON.stringify on objects
// depends on the order in which the properties were defined - which we don't like!
// Additionally, JSON.stringify escapes strings, which we don't need here
function stringifyObject(object, keys = (Object.keys(object).concat(Object.getOwnPropertySymbols(object)))) {
  return keys.sort().map(key => `${key.toString()}:${stringifyValue(object[key], key)}`).join('|');
}

export function getCacheKey(model, attribute, options) {
  // TODO: better way?? related to changes in graphql-sequelize so that findOptions have requestUser
  optionsKey = stringifyObject(options, ['association', 'attributes', 'groupedLimit', 'limit', 'offset', 'order', 'where', 'through', 'raw', 'requestUser']);

  return `${model.name}|${attribute}|${optionsKey}`;
}

function mergeWhere(where, optionsWhere) {
  if (optionsWhere) {
    return {
      $and: [where, optionsWhere]
    };
  }
  return where;
}

function rejectOnEmpty(options, result) {
  if (isEmpty(result) && options.rejectOnEmpty) {
    if (typeof options.rejectOnEmpty === 'function') {
      throw new options.rejectOnEmpty();
    } else if (typeof options.rejectOnEmpty === 'object') {
      throw options.rejectOnEmpty;
    } else {
      throw new Sequelize.EmptyResultError();
    }
  }

  return result;
}

function loaderForBTM(model, joinTableName, foreignKey, foreignKeyField, options = {}) {
  assert(options.include === undefined, 'options.include is not supported by model loader');
  assert(options.association !== undefined, 'options.association should be set for BTM loader');

  let attributes = [joinTableName, foreignKey]
    , cacheKey = getCacheKey(model, attributes, options)
    , association = options.association;
  delete options.association;

  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, new DataLoader(keys => {
      let findOptions = Object.assign({}, options);
      delete findOptions.rejectOnEmpty;
      if (findOptions.limit) {
        findOptions.groupedLimit = {
          through: options.through,
          on: association,
          limit: findOptions.limit,
          offset: findOptions.offset,
          values: keys
        };
      } else {
        findOptions.include = [{
          // need to get all attributes of through table in the query only when count/group is not happening
          attributes: findOptions.group ? [foreignKey] : null,
          association: association.manyFromSource,
          where: {
            [foreignKeyField]: keys,
            ...options.through.where
          }
        }];
      }

      return model.findAll(findOptions).then(mapResult.bind(null, attributes, keys, findOptions));
    }, {
      cache: false
    }));
  }

  return cache.get(cacheKey);
}

function loaderForModel(model, attribute, attributeField, options = {}) {
  assert(options.include === undefined, 'options.include is not supported by model loader');

  let cacheKey = getCacheKey(model, attribute, options);

  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, new DataLoader(keys => {
      const findOptions = Object.assign({}, options);
      delete findOptions.rejectOnEmpty;

      if (findOptions.limit && keys.length > 1) {
        findOptions.groupedLimit = {
          limit: findOptions.limit,
          on: attributeField,
          values: keys
        };
        delete findOptions.limit;
      } else {
        findOptions.where = mergeWhere({
          [attributeField]: keys
        }, findOptions.where);
      }

      return model.findAll(findOptions).then(mapResult.bind(null, attribute, keys, findOptions));
    }, {
      cache: false
    }));
  }

  return cache.get(cacheKey);
}

function shimModel(target) {
  if (target.findByPk ? target.findByPk.__wrapped : target.findById.__wrapped) return;

  shimmer.massWrap(target, methods(Sequelize.version).findByPk, original => {
    return function batchedFindById(id, options = {}) {
      if ([null, undefined].indexOf(id) !== -1) {
        return Promise.resolve(null);
      }
      if (options.transaction || options.include) {
        return original.apply(this, arguments);
      }
      // TODO: review this approach later. Add options so that request parameters can be passed on if required
      return loaderForModel(this, this.primaryKeyAttribute, this.primaryKeyField, options).load(id).then(rejectOnEmpty.bind(null, options));
    };
  });
}

function shimBelongsTo(target) {
  if (target.get.__wrapped) return;

  shimmer.wrap(target, 'get', original => {
    return function batchedGetBelongsTo(instance, options = {}) {
      if (Array.isArray(instance) || options.include || options.transaction) {
        return original.apply(this, arguments);
      }

      let foreignKeyValue = instance.get(this.foreignKey);
      return Promise.resolve().then(() => {
        if (foreignKeyValue === undefined || foreignKeyValue === null) {
          return Promise.resolve(null);
        }
        let loader = loaderForModel(this.target, this.targetKey, this.targetKeyField, options);
        return loader.load(foreignKeyValue);
      }).then(rejectOnEmpty.bind(null, options));
    };
  });
}

function shimHasOne(target) {
  if (target.get.__wrapped) return;

  shimmer.wrap(target, 'get', original => {
    return function batchedGetHasOne(instance, options = {}) {
      if (Array.isArray(instance) || options.include || options.transaction) {
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
          $and: [
            options.where,
            scope
          ]
        };
      }

      let loader = loaderForModel(this.target, this.foreignKey, this.identifierField, options);
      return loader.load(instance.get(this.sourceKey)).then(rejectOnEmpty.bind(null, options));
    };
  });
}

function shimHasMany(target) {
  if (target.get.__wrapped) return;

  shimmer.wrap(target, 'get', original => {
    return function bathedGetHasMany(instances, options = {}) {
      let isCount = false;
      if (options.include || options.transaction) {
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
          $and: [
            options.where,
            scope
          ]
        };
      }

      let loader = loaderForModel(this.target, this.foreignKey, this.foreignKeyField, {
        multiple: true,
        ...options
      });

      let key = this.sourceKey || this.source.primaryKeyAttribute;

      if (Array.isArray(instances)) {
        return Promise.map(instances, instance => loader.load(instance.get(key)));
      } else {
        return loader.load(instances.get(key)).then(result => {
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

  shimmer.wrap(target, 'get', original => {
    return function bathedGetHasMany(instances, options = {}) {
      let isCount = false;
      assert(this.paired, '.paired missing on belongsToMany association. You need to set up both sides of the association');

      if (options.include || options.transaction) {
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
          $and: [
            options.where,
            scope
          ]
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
          $and: [
            options.through.where,
            scope
          ]
        };
      }

      let loader = loaderForBTM(this.target, this.paired.manyFromSource.as, this.foreignKey, this.identifierField, {
        association: this.paired,
        multiple: true,
        ...options
      });

      if (Array.isArray(instances)) {
        return Promise.map(instances, instance => loader.load(instance.get(this.source.primaryKeyAttribute)));
      } else {
        return loader.load(instances.get(this.source.primaryKeyAttribute)).then(result => {
          if (isCount && !result) {
            result = { count: 0 };
          }
          return result;
        }).then(rejectOnEmpty.bind(null, options));
      }
    };
  });
}

function shimAssociation(association) {
  switch (association.associationType) {
    case 'BelongsTo': return shimBelongsTo(association);
    case 'HasOne': return shimHasOne(association);
    case 'HasMany': return shimHasMany(association);
    case 'BelongsToMany': return shimBelongsToMany(association);
  }
}

let cache;
export function resetCache() {
  if (cache) cache.reset();
}
export default function (target, options = {}) {
  options = {
    ...options,
    max: 500
  };

  if (!cache) {
    cache = LRU(options);
  }

  if (target.associationType) {
    shimAssociation(target);
  // change for sequelize 4.0.0.2
  } else if (target.toString().includes('Model')) {
    shimModel(target);
    values(target.associations).forEach(shimAssociation);
  } else {
    // Assume target is the sequelize constructor
    shimModel(target.Model.prototype);
    shimBelongsTo(target.Association.BelongsTo.prototype);
    shimHasOne(target.Association.HasOne.prototype);
    shimHasMany(target.Association.HasMany.prototype);
    shimBelongsToMany(target.Association.BelongsToMany.prototype);
  }
}
