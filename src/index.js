import * as t from 'babel-types';

const ignoredNode = Symbol('ignoredNode');

let shouldTransform = false;

// returns t.memberExpression but marked to be ignored when visited
function getIgnoredMemberExpression(object, property, computed) {
  let node = t.memberExpression(object, property, computed);
  node[ignoredNode] = true;
  return node;
}

// var safeGetItem = require('../lib/safe_get.js').safeGetItem;
function generateRequire(method, safeGetFilePath) {
  return t.variableDeclaration(
    'var',
    [
      t.variableDeclarator(
        t.identifier(method),
        getIgnoredMemberExpression(
          t.callExpression(
            t.identifier('require'),
            [
              t.stringLiteral(safeGetFilePath)
            ]
          ),
          t.identifier(method),
          false
        )
      )
    ]
  );
};

// safeGetItem(object, 'property');
// safeGetAttr(object, 'property');
function generateSafeGetCall(object, property, computed) {
  let functionName;
  let propertyNode;
  if (computed) {
    functionName = 'safeGetAttr';
    propertyNode = property;
  } else {
    functionName = 'safeGetItem';
    propertyNode = t.stringLiteral(property.name);
  }

  return t.callExpression(
    t.identifier(functionName),
    [
      object,
      propertyNode
    ]
  );
};

function splitMultipleDirectives(directive) {
  if (!directive.startsWith('use ')) {
    return [];
  }

  return directive.slice(4) // ommit 'use '
    .split(',')
    .map((directive) => directive.trim());
}

export default function() {
  return {
    visitor: {
      Program(path, {opts}) {
        let directivePolicy = opts['directivePolicy'];
        if (!directivePolicy) {
          directivePolicy = 'opt in'; // default policy
        }

        let foundPositiveDirective = false;
        let foundNegativeDirective = false;

        for (const directiveNode of path.node.directives) {
          const directiveString = directiveNode.value.value;
          const directives = splitMultipleDirectives(directiveString);
          for (const directive of directives) {
            if (directive === 'superstrict') {
              foundPositiveDirective = true;
            } else if (directive === '!superstrict') {
              foundNegativeDirective = true;
            }
          }
        }

        shouldTransform = true;
        // 'opt in' transpiles only files with positive directive
        if ((directivePolicy === 'opt in') && (!foundPositiveDirective)) {
          shouldTransform = false;
        // 'opt out' transpiles all files except those with negative directive
        } else if ((directivePolicy === 'opt out') && (foundNegativeDirective)) {
          shouldTransform = false;
        // in other cases or with 'everything' policy transpile file
        }
        if (shouldTransform) {
          path.node.body = [
            generateRequire('safeGetItem', opts['safeGetFilePath']),
            generateRequire('safeGetAttr', opts['safeGetFilePath']),
            generateRequire('checkIn', opts['safeGetFilePath']),
            generateRequire('checkCastingBinary', opts['checkCastingFilePath']),
            generateRequire('checkCastingUnaryPrefix', opts['checkCastingFilePath']),
            generateRequire('checkCastingUnaryPostfix', opts['checkCastingFilePath']),
            ...path.node.body
          ];
        }
        path.traverse({
          // ignore left sides of assignments
          AssignmentExpression(path) {
            if (!shouldTransform) { return; }
            path.node.left[ignoredNode] = true;
          },
          MemberExpression(path) {
            if (!shouldTransform || path.node[ignoredNode]) { return; }
            path.replaceWith(generateSafeGetCall(
              path.node.object,
              path.node.property,
              path.node.computed
            ));
          },
          UnaryExpression(path) {
            if (!shouldTransform) { return; }
            if (['++', '--', '+', '-', '~'].indexOf(path.node.operator) !== -1) {
              path.replaceWith(t.callExpression(
                t.identifier('checkCastingUnaryPrefix'),
                [
                  path.node.argument,
                  t.stringLiteral(path.node.operator)
                ]
              ));
            }
          },
          UpdateExpression(path) {
            if (!shouldTransform || path.node[ignoredNode]) { return; }
            const {node, node: {argument, operator, prefix}} = path;

            if (prefix) {
              path.replaceWith(t.callExpression(
                t.identifier('checkCastingUnaryPrefix'),
                [
                  argument,
                  t.stringLiteral(operator)
                ]
              ));
            } else { // postfix increment/decrement
              let checkedExpression = t.callExpression(
                t.identifier('checkCastingUnaryPostfix'),
                [
                  argument, // original value to determine type
                  node, // whole updateExpression to increment/decrement
                        // variable in original scope
                  t.stringLiteral(operator)
                ]
              );
              path.replaceWith(checkedExpression);
              // traverse all the nodes we just added and mark them as 'to be ignored'. This is
              // necessary for avoiding infinite recursion. Matej Krajcovic used path.skip() to
              // solve this, however I ran into some issues with .skip() and I cannot find .skip()
              // documented.
              path.traverse({
                UpdateExpression(path) {
                  path.node[ignoredNode] = true;
                }
              });
            }
          },
          BinaryExpression(path) {
            if (!shouldTransform) { return; }
            const {left, right, operator} = path.node;
            let functionName, object, property;

            if (['+', '-', '*', '/', '%', '<', '>', '<=', '>=',
                 '<<', '>>', '>>>', '&', '^', '|']
              .indexOf(operator) !== -1) {
              functionName = 'checkCastingBinary';
              object = left;
              property = right;
            } else if (operator === 'in') {
              functionName = 'checkIn';
              object = right;
              property = left;
            }

            if (functionName) {
              path.replaceWith(t.callExpression(
                t.identifier(functionName),
                [
                  object,
                  property,
                  t.stringLiteral(operator)
                ]
              ));
            }
          }
        });
      },
    }
  };
}
