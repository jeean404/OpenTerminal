var If = Object.defineProperty;
var Ff = (m, v, c) => v in m ? If(m, v, { enumerable: !0, configurable: !0, writable: !0, value: c }) : m[v] = c;
var Tl = (m, v, c) => Ff(m, typeof v != "symbol" ? v + "" : v, c);
function Uf(m) {
  return m && m.__esModule && Object.prototype.hasOwnProperty.call(m, "default") ? m.default : m;
}
var Ei = { exports: {} }, gr = {}, Ci = { exports: {} }, $ = {};
/**
 * @license React
 * react.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Na;
function Af() {
  if (Na) return $;
  Na = 1;
  var m = Symbol.for("react.element"), v = Symbol.for("react.portal"), c = Symbol.for("react.fragment"), T = Symbol.for("react.strict_mode"), U = Symbol.for("react.profiler"), H = Symbol.for("react.provider"), Y = Symbol.for("react.context"), ee = Symbol.for("react.forward_ref"), Q = Symbol.for("react.suspense"), J = Symbol.for("react.memo"), se = Symbol.for("react.lazy"), O = Symbol.iterator;
  function C(f) {
    return f === null || typeof f != "object" ? null : (f = O && f[O] || f["@@iterator"], typeof f == "function" ? f : null);
  }
  var W = { isMounted: function() {
    return !1;
  }, enqueueForceUpdate: function() {
  }, enqueueReplaceState: function() {
  }, enqueueSetState: function() {
  } }, te = Object.assign, V = {};
  function F(f, g, A) {
    this.props = f, this.context = g, this.refs = V, this.updater = A || W;
  }
  F.prototype.isReactComponent = {}, F.prototype.setState = function(f, g) {
    if (typeof f != "object" && typeof f != "function" && f != null) throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");
    this.updater.enqueueSetState(this, f, g, "setState");
  }, F.prototype.forceUpdate = function(f) {
    this.updater.enqueueForceUpdate(this, f, "forceUpdate");
  };
  function pe() {
  }
  pe.prototype = F.prototype;
  function Ne(f, g, A) {
    this.props = f, this.context = g, this.refs = V, this.updater = A || W;
  }
  var ye = Ne.prototype = new pe();
  ye.constructor = Ne, te(ye, F.prototype), ye.isPureReactComponent = !0;
  var ge = Array.isArray, Pe = Object.prototype.hasOwnProperty, je = { current: null }, De = { key: !0, ref: !0, __self: !0, __source: !0 };
  function Ge(f, g, A) {
    var B, X = {}, G = null, ne = null;
    if (g != null) for (B in g.ref !== void 0 && (ne = g.ref), g.key !== void 0 && (G = "" + g.key), g) Pe.call(g, B) && !De.hasOwnProperty(B) && (X[B] = g[B]);
    var q = arguments.length - 2;
    if (q === 1) X.children = A;
    else if (1 < q) {
      for (var ie = Array(q), We = 0; We < q; We++) ie[We] = arguments[We + 2];
      X.children = ie;
    }
    if (f && f.defaultProps) for (B in q = f.defaultProps, q) X[B] === void 0 && (X[B] = q[B]);
    return { $$typeof: m, type: f, key: G, ref: ne, props: X, _owner: je.current };
  }
  function Nt(f, g) {
    return { $$typeof: m, type: f.type, key: g, ref: f.ref, props: f.props, _owner: f._owner };
  }
  function yt(f) {
    return typeof f == "object" && f !== null && f.$$typeof === m;
  }
  function Yt(f) {
    var g = { "=": "=0", ":": "=2" };
    return "$" + f.replace(/[=:]/g, function(A) {
      return g[A];
    });
  }
  var ct = /\/+/g;
  function He(f, g) {
    return typeof f == "object" && f !== null && f.key != null ? Yt("" + f.key) : g.toString(36);
  }
  function nt(f, g, A, B, X) {
    var G = typeof f;
    (G === "undefined" || G === "boolean") && (f = null);
    var ne = !1;
    if (f === null) ne = !0;
    else switch (G) {
      case "string":
      case "number":
        ne = !0;
        break;
      case "object":
        switch (f.$$typeof) {
          case m:
          case v:
            ne = !0;
        }
    }
    if (ne) return ne = f, X = X(ne), f = B === "" ? "." + He(ne, 0) : B, ge(X) ? (A = "", f != null && (A = f.replace(ct, "$&/") + "/"), nt(X, g, A, "", function(We) {
      return We;
    })) : X != null && (yt(X) && (X = Nt(X, A + (!X.key || ne && ne.key === X.key ? "" : ("" + X.key).replace(ct, "$&/") + "/") + f)), g.push(X)), 1;
    if (ne = 0, B = B === "" ? "." : B + ":", ge(f)) for (var q = 0; q < f.length; q++) {
      G = f[q];
      var ie = B + He(G, q);
      ne += nt(G, g, A, ie, X);
    }
    else if (ie = C(f), typeof ie == "function") for (f = ie.call(f), q = 0; !(G = f.next()).done; ) G = G.value, ie = B + He(G, q++), ne += nt(G, g, A, ie, X);
    else if (G === "object") throw g = String(f), Error("Objects are not valid as a React child (found: " + (g === "[object Object]" ? "object with keys {" + Object.keys(f).join(", ") + "}" : g) + "). If you meant to render a collection of children, use an array instead.");
    return ne;
  }
  function ft(f, g, A) {
    if (f == null) return f;
    var B = [], X = 0;
    return nt(f, B, "", "", function(G) {
      return g.call(A, G, X++);
    }), B;
  }
  function Ie(f) {
    if (f._status === -1) {
      var g = f._result;
      g = g(), g.then(function(A) {
        (f._status === 0 || f._status === -1) && (f._status = 1, f._result = A);
      }, function(A) {
        (f._status === 0 || f._status === -1) && (f._status = 2, f._result = A);
      }), f._status === -1 && (f._status = 0, f._result = g);
    }
    if (f._status === 1) return f._result.default;
    throw f._result;
  }
  var fe = { current: null }, _ = { transition: null }, D = { ReactCurrentDispatcher: fe, ReactCurrentBatchConfig: _, ReactCurrentOwner: je };
  function N() {
    throw Error("act(...) is not supported in production builds of React.");
  }
  return $.Children = { map: ft, forEach: function(f, g, A) {
    ft(f, function() {
      g.apply(this, arguments);
    }, A);
  }, count: function(f) {
    var g = 0;
    return ft(f, function() {
      g++;
    }), g;
  }, toArray: function(f) {
    return ft(f, function(g) {
      return g;
    }) || [];
  }, only: function(f) {
    if (!yt(f)) throw Error("React.Children.only expected to receive a single React element child.");
    return f;
  } }, $.Component = F, $.Fragment = c, $.Profiler = U, $.PureComponent = Ne, $.StrictMode = T, $.Suspense = Q, $.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = D, $.act = N, $.cloneElement = function(f, g, A) {
    if (f == null) throw Error("React.cloneElement(...): The argument must be a React element, but you passed " + f + ".");
    var B = te({}, f.props), X = f.key, G = f.ref, ne = f._owner;
    if (g != null) {
      if (g.ref !== void 0 && (G = g.ref, ne = je.current), g.key !== void 0 && (X = "" + g.key), f.type && f.type.defaultProps) var q = f.type.defaultProps;
      for (ie in g) Pe.call(g, ie) && !De.hasOwnProperty(ie) && (B[ie] = g[ie] === void 0 && q !== void 0 ? q[ie] : g[ie]);
    }
    var ie = arguments.length - 2;
    if (ie === 1) B.children = A;
    else if (1 < ie) {
      q = Array(ie);
      for (var We = 0; We < ie; We++) q[We] = arguments[We + 2];
      B.children = q;
    }
    return { $$typeof: m, type: f.type, key: X, ref: G, props: B, _owner: ne };
  }, $.createContext = function(f) {
    return f = { $$typeof: Y, _currentValue: f, _currentValue2: f, _threadCount: 0, Provider: null, Consumer: null, _defaultValue: null, _globalName: null }, f.Provider = { $$typeof: H, _context: f }, f.Consumer = f;
  }, $.createElement = Ge, $.createFactory = function(f) {
    var g = Ge.bind(null, f);
    return g.type = f, g;
  }, $.createRef = function() {
    return { current: null };
  }, $.forwardRef = function(f) {
    return { $$typeof: ee, render: f };
  }, $.isValidElement = yt, $.lazy = function(f) {
    return { $$typeof: se, _payload: { _status: -1, _result: f }, _init: Ie };
  }, $.memo = function(f, g) {
    return { $$typeof: J, type: f, compare: g === void 0 ? null : g };
  }, $.startTransition = function(f) {
    var g = _.transition;
    _.transition = {};
    try {
      f();
    } finally {
      _.transition = g;
    }
  }, $.unstable_act = N, $.useCallback = function(f, g) {
    return fe.current.useCallback(f, g);
  }, $.useContext = function(f) {
    return fe.current.useContext(f);
  }, $.useDebugValue = function() {
  }, $.useDeferredValue = function(f) {
    return fe.current.useDeferredValue(f);
  }, $.useEffect = function(f, g) {
    return fe.current.useEffect(f, g);
  }, $.useId = function() {
    return fe.current.useId();
  }, $.useImperativeHandle = function(f, g, A) {
    return fe.current.useImperativeHandle(f, g, A);
  }, $.useInsertionEffect = function(f, g) {
    return fe.current.useInsertionEffect(f, g);
  }, $.useLayoutEffect = function(f, g) {
    return fe.current.useLayoutEffect(f, g);
  }, $.useMemo = function(f, g) {
    return fe.current.useMemo(f, g);
  }, $.useReducer = function(f, g, A) {
    return fe.current.useReducer(f, g, A);
  }, $.useRef = function(f) {
    return fe.current.useRef(f);
  }, $.useState = function(f) {
    return fe.current.useState(f);
  }, $.useSyncExternalStore = function(f, g, A) {
    return fe.current.useSyncExternalStore(f, g, A);
  }, $.useTransition = function() {
    return fe.current.useTransition();
  }, $.version = "18.3.1", $;
}
var Pa;
function Ri() {
  return Pa || (Pa = 1, Ci.exports = Af()), Ci.exports;
}
/**
 * @license React
 * react-jsx-runtime.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var za;
function Vf() {
  if (za) return gr;
  za = 1;
  var m = Ri(), v = Symbol.for("react.element"), c = Symbol.for("react.fragment"), T = Object.prototype.hasOwnProperty, U = m.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner, H = { key: !0, ref: !0, __self: !0, __source: !0 };
  function Y(ee, Q, J) {
    var se, O = {}, C = null, W = null;
    J !== void 0 && (C = "" + J), Q.key !== void 0 && (C = "" + Q.key), Q.ref !== void 0 && (W = Q.ref);
    for (se in Q) T.call(Q, se) && !H.hasOwnProperty(se) && (O[se] = Q[se]);
    if (ee && ee.defaultProps) for (se in Q = ee.defaultProps, Q) O[se] === void 0 && (O[se] = Q[se]);
    return { $$typeof: v, type: ee, key: C, ref: W, props: O, _owner: U.current };
  }
  return gr.Fragment = c, gr.jsx = Y, gr.jsxs = Y, gr;
}
var Ta;
function $f() {
  return Ta || (Ta = 1, Ei.exports = Vf()), Ei.exports;
}
var L = $f(), Rl = {}, Ni = { exports: {} }, Be = {}, Pi = { exports: {} }, zi = {};
/**
 * @license React
 * scheduler.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Ra;
function Bf() {
  return Ra || (Ra = 1, (function(m) {
    function v(_, D) {
      var N = _.length;
      _.push(D);
      e: for (; 0 < N; ) {
        var f = N - 1 >>> 1, g = _[f];
        if (0 < U(g, D)) _[f] = D, _[N] = g, N = f;
        else break e;
      }
    }
    function c(_) {
      return _.length === 0 ? null : _[0];
    }
    function T(_) {
      if (_.length === 0) return null;
      var D = _[0], N = _.pop();
      if (N !== D) {
        _[0] = N;
        e: for (var f = 0, g = _.length, A = g >>> 1; f < A; ) {
          var B = 2 * (f + 1) - 1, X = _[B], G = B + 1, ne = _[G];
          if (0 > U(X, N)) G < g && 0 > U(ne, X) ? (_[f] = ne, _[G] = N, f = G) : (_[f] = X, _[B] = N, f = B);
          else if (G < g && 0 > U(ne, N)) _[f] = ne, _[G] = N, f = G;
          else break e;
        }
      }
      return D;
    }
    function U(_, D) {
      var N = _.sortIndex - D.sortIndex;
      return N !== 0 ? N : _.id - D.id;
    }
    if (typeof performance == "object" && typeof performance.now == "function") {
      var H = performance;
      m.unstable_now = function() {
        return H.now();
      };
    } else {
      var Y = Date, ee = Y.now();
      m.unstable_now = function() {
        return Y.now() - ee;
      };
    }
    var Q = [], J = [], se = 1, O = null, C = 3, W = !1, te = !1, V = !1, F = typeof setTimeout == "function" ? setTimeout : null, pe = typeof clearTimeout == "function" ? clearTimeout : null, Ne = typeof setImmediate < "u" ? setImmediate : null;
    typeof navigator < "u" && navigator.scheduling !== void 0 && navigator.scheduling.isInputPending !== void 0 && navigator.scheduling.isInputPending.bind(navigator.scheduling);
    function ye(_) {
      for (var D = c(J); D !== null; ) {
        if (D.callback === null) T(J);
        else if (D.startTime <= _) T(J), D.sortIndex = D.expirationTime, v(Q, D);
        else break;
        D = c(J);
      }
    }
    function ge(_) {
      if (V = !1, ye(_), !te) if (c(Q) !== null) te = !0, Ie(Pe);
      else {
        var D = c(J);
        D !== null && fe(ge, D.startTime - _);
      }
    }
    function Pe(_, D) {
      te = !1, V && (V = !1, pe(Ge), Ge = -1), W = !0;
      var N = C;
      try {
        for (ye(D), O = c(Q); O !== null && (!(O.expirationTime > D) || _ && !Yt()); ) {
          var f = O.callback;
          if (typeof f == "function") {
            O.callback = null, C = O.priorityLevel;
            var g = f(O.expirationTime <= D);
            D = m.unstable_now(), typeof g == "function" ? O.callback = g : O === c(Q) && T(Q), ye(D);
          } else T(Q);
          O = c(Q);
        }
        if (O !== null) var A = !0;
        else {
          var B = c(J);
          B !== null && fe(ge, B.startTime - D), A = !1;
        }
        return A;
      } finally {
        O = null, C = N, W = !1;
      }
    }
    var je = !1, De = null, Ge = -1, Nt = 5, yt = -1;
    function Yt() {
      return !(m.unstable_now() - yt < Nt);
    }
    function ct() {
      if (De !== null) {
        var _ = m.unstable_now();
        yt = _;
        var D = !0;
        try {
          D = De(!0, _);
        } finally {
          D ? He() : (je = !1, De = null);
        }
      } else je = !1;
    }
    var He;
    if (typeof Ne == "function") He = function() {
      Ne(ct);
    };
    else if (typeof MessageChannel < "u") {
      var nt = new MessageChannel(), ft = nt.port2;
      nt.port1.onmessage = ct, He = function() {
        ft.postMessage(null);
      };
    } else He = function() {
      F(ct, 0);
    };
    function Ie(_) {
      De = _, je || (je = !0, He());
    }
    function fe(_, D) {
      Ge = F(function() {
        _(m.unstable_now());
      }, D);
    }
    m.unstable_IdlePriority = 5, m.unstable_ImmediatePriority = 1, m.unstable_LowPriority = 4, m.unstable_NormalPriority = 3, m.unstable_Profiling = null, m.unstable_UserBlockingPriority = 2, m.unstable_cancelCallback = function(_) {
      _.callback = null;
    }, m.unstable_continueExecution = function() {
      te || W || (te = !0, Ie(Pe));
    }, m.unstable_forceFrameRate = function(_) {
      0 > _ || 125 < _ ? console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported") : Nt = 0 < _ ? Math.floor(1e3 / _) : 5;
    }, m.unstable_getCurrentPriorityLevel = function() {
      return C;
    }, m.unstable_getFirstCallbackNode = function() {
      return c(Q);
    }, m.unstable_next = function(_) {
      switch (C) {
        case 1:
        case 2:
        case 3:
          var D = 3;
          break;
        default:
          D = C;
      }
      var N = C;
      C = D;
      try {
        return _();
      } finally {
        C = N;
      }
    }, m.unstable_pauseExecution = function() {
    }, m.unstable_requestPaint = function() {
    }, m.unstable_runWithPriority = function(_, D) {
      switch (_) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
          break;
        default:
          _ = 3;
      }
      var N = C;
      C = _;
      try {
        return D();
      } finally {
        C = N;
      }
    }, m.unstable_scheduleCallback = function(_, D, N) {
      var f = m.unstable_now();
      switch (typeof N == "object" && N !== null ? (N = N.delay, N = typeof N == "number" && 0 < N ? f + N : f) : N = f, _) {
        case 1:
          var g = -1;
          break;
        case 2:
          g = 250;
          break;
        case 5:
          g = 1073741823;
          break;
        case 4:
          g = 1e4;
          break;
        default:
          g = 5e3;
      }
      return g = N + g, _ = { id: se++, callback: D, priorityLevel: _, startTime: N, expirationTime: g, sortIndex: -1 }, N > f ? (_.sortIndex = N, v(J, _), c(Q) === null && _ === c(J) && (V ? (pe(Ge), Ge = -1) : V = !0, fe(ge, N - f))) : (_.sortIndex = g, v(Q, _), te || W || (te = !0, Ie(Pe))), _;
    }, m.unstable_shouldYield = Yt, m.unstable_wrapCallback = function(_) {
      var D = C;
      return function() {
        var N = C;
        C = D;
        try {
          return _.apply(this, arguments);
        } finally {
          C = N;
        }
      };
    };
  })(zi)), zi;
}
var La;
function Hf() {
  return La || (La = 1, Pi.exports = Bf()), Pi.exports;
}
/**
 * @license React
 * react-dom.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var ja;
function Wf() {
  if (ja) return Be;
  ja = 1;
  var m = Ri(), v = Hf();
  function c(e) {
    for (var t = "https://reactjs.org/docs/error-decoder.html?invariant=" + e, n = 1; n < arguments.length; n++) t += "&args[]=" + encodeURIComponent(arguments[n]);
    return "Minified React error #" + e + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  var T = /* @__PURE__ */ new Set(), U = {};
  function H(e, t) {
    Y(e, t), Y(e + "Capture", t);
  }
  function Y(e, t) {
    for (U[e] = t, e = 0; e < t.length; e++) T.add(t[e]);
  }
  var ee = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), Q = Object.prototype.hasOwnProperty, J = /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/, se = {}, O = {};
  function C(e) {
    return Q.call(O, e) ? !0 : Q.call(se, e) ? !1 : J.test(e) ? O[e] = !0 : (se[e] = !0, !1);
  }
  function W(e, t, n, r) {
    if (n !== null && n.type === 0) return !1;
    switch (typeof t) {
      case "function":
      case "symbol":
        return !0;
      case "boolean":
        return r ? !1 : n !== null ? !n.acceptsBooleans : (e = e.toLowerCase().slice(0, 5), e !== "data-" && e !== "aria-");
      default:
        return !1;
    }
  }
  function te(e, t, n, r) {
    if (t === null || typeof t > "u" || W(e, t, n, r)) return !0;
    if (r) return !1;
    if (n !== null) switch (n.type) {
      case 3:
        return !t;
      case 4:
        return t === !1;
      case 5:
        return isNaN(t);
      case 6:
        return isNaN(t) || 1 > t;
    }
    return !1;
  }
  function V(e, t, n, r, l, u, i) {
    this.acceptsBooleans = t === 2 || t === 3 || t === 4, this.attributeName = r, this.attributeNamespace = l, this.mustUseProperty = n, this.propertyName = e, this.type = t, this.sanitizeURL = u, this.removeEmptyString = i;
  }
  var F = {};
  "children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e) {
    F[e] = new V(e, 0, !1, e, null, !1, !1);
  }), [["acceptCharset", "accept-charset"], ["className", "class"], ["htmlFor", "for"], ["httpEquiv", "http-equiv"]].forEach(function(e) {
    var t = e[0];
    F[t] = new V(t, 1, !1, e[1], null, !1, !1);
  }), ["contentEditable", "draggable", "spellCheck", "value"].forEach(function(e) {
    F[e] = new V(e, 2, !1, e.toLowerCase(), null, !1, !1);
  }), ["autoReverse", "externalResourcesRequired", "focusable", "preserveAlpha"].forEach(function(e) {
    F[e] = new V(e, 2, !1, e, null, !1, !1);
  }), "allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e) {
    F[e] = new V(e, 3, !1, e.toLowerCase(), null, !1, !1);
  }), ["checked", "multiple", "muted", "selected"].forEach(function(e) {
    F[e] = new V(e, 3, !0, e, null, !1, !1);
  }), ["capture", "download"].forEach(function(e) {
    F[e] = new V(e, 4, !1, e, null, !1, !1);
  }), ["cols", "rows", "size", "span"].forEach(function(e) {
    F[e] = new V(e, 6, !1, e, null, !1, !1);
  }), ["rowSpan", "start"].forEach(function(e) {
    F[e] = new V(e, 5, !1, e.toLowerCase(), null, !1, !1);
  });
  var pe = /[\-:]([a-z])/g;
  function Ne(e) {
    return e[1].toUpperCase();
  }
  "accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e) {
    var t = e.replace(
      pe,
      Ne
    );
    F[t] = new V(t, 1, !1, e, null, !1, !1);
  }), "xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e) {
    var t = e.replace(pe, Ne);
    F[t] = new V(t, 1, !1, e, "http://www.w3.org/1999/xlink", !1, !1);
  }), ["xml:base", "xml:lang", "xml:space"].forEach(function(e) {
    var t = e.replace(pe, Ne);
    F[t] = new V(t, 1, !1, e, "http://www.w3.org/XML/1998/namespace", !1, !1);
  }), ["tabIndex", "crossOrigin"].forEach(function(e) {
    F[e] = new V(e, 1, !1, e.toLowerCase(), null, !1, !1);
  }), F.xlinkHref = new V("xlinkHref", 1, !1, "xlink:href", "http://www.w3.org/1999/xlink", !0, !1), ["src", "href", "action", "formAction"].forEach(function(e) {
    F[e] = new V(e, 1, !1, e.toLowerCase(), null, !0, !0);
  });
  function ye(e, t, n, r) {
    var l = F.hasOwnProperty(t) ? F[t] : null;
    (l !== null ? l.type !== 0 : r || !(2 < t.length) || t[0] !== "o" && t[0] !== "O" || t[1] !== "n" && t[1] !== "N") && (te(t, n, l, r) && (n = null), r || l === null ? C(t) && (n === null ? e.removeAttribute(t) : e.setAttribute(t, "" + n)) : l.mustUseProperty ? e[l.propertyName] = n === null ? l.type === 3 ? !1 : "" : n : (t = l.attributeName, r = l.attributeNamespace, n === null ? e.removeAttribute(t) : (l = l.type, n = l === 3 || l === 4 && n === !0 ? "" : "" + n, r ? e.setAttributeNS(r, t, n) : e.setAttribute(t, n))));
  }
  var ge = m.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED, Pe = Symbol.for("react.element"), je = Symbol.for("react.portal"), De = Symbol.for("react.fragment"), Ge = Symbol.for("react.strict_mode"), Nt = Symbol.for("react.profiler"), yt = Symbol.for("react.provider"), Yt = Symbol.for("react.context"), ct = Symbol.for("react.forward_ref"), He = Symbol.for("react.suspense"), nt = Symbol.for("react.suspense_list"), ft = Symbol.for("react.memo"), Ie = Symbol.for("react.lazy"), fe = Symbol.for("react.offscreen"), _ = Symbol.iterator;
  function D(e) {
    return e === null || typeof e != "object" ? null : (e = _ && e[_] || e["@@iterator"], typeof e == "function" ? e : null);
  }
  var N = Object.assign, f;
  function g(e) {
    if (f === void 0) try {
      throw Error();
    } catch (n) {
      var t = n.stack.trim().match(/\n( *(at )?)/);
      f = t && t[1] || "";
    }
    return `
` + f + e;
  }
  var A = !1;
  function B(e, t) {
    if (!e || A) return "";
    A = !0;
    var n = Error.prepareStackTrace;
    Error.prepareStackTrace = void 0;
    try {
      if (t) if (t = function() {
        throw Error();
      }, Object.defineProperty(t.prototype, "props", { set: function() {
        throw Error();
      } }), typeof Reflect == "object" && Reflect.construct) {
        try {
          Reflect.construct(t, []);
        } catch (h) {
          var r = h;
        }
        Reflect.construct(e, [], t);
      } else {
        try {
          t.call();
        } catch (h) {
          r = h;
        }
        e.call(t.prototype);
      }
      else {
        try {
          throw Error();
        } catch (h) {
          r = h;
        }
        e();
      }
    } catch (h) {
      if (h && r && typeof h.stack == "string") {
        for (var l = h.stack.split(`
`), u = r.stack.split(`
`), i = l.length - 1, o = u.length - 1; 1 <= i && 0 <= o && l[i] !== u[o]; ) o--;
        for (; 1 <= i && 0 <= o; i--, o--) if (l[i] !== u[o]) {
          if (i !== 1 || o !== 1)
            do
              if (i--, o--, 0 > o || l[i] !== u[o]) {
                var s = `
` + l[i].replace(" at new ", " at ");
                return e.displayName && s.includes("<anonymous>") && (s = s.replace("<anonymous>", e.displayName)), s;
              }
            while (1 <= i && 0 <= o);
          break;
        }
      }
    } finally {
      A = !1, Error.prepareStackTrace = n;
    }
    return (e = e ? e.displayName || e.name : "") ? g(e) : "";
  }
  function X(e) {
    switch (e.tag) {
      case 5:
        return g(e.type);
      case 16:
        return g("Lazy");
      case 13:
        return g("Suspense");
      case 19:
        return g("SuspenseList");
      case 0:
      case 2:
      case 15:
        return e = B(e.type, !1), e;
      case 11:
        return e = B(e.type.render, !1), e;
      case 1:
        return e = B(e.type, !0), e;
      default:
        return "";
    }
  }
  function G(e) {
    if (e == null) return null;
    if (typeof e == "function") return e.displayName || e.name || null;
    if (typeof e == "string") return e;
    switch (e) {
      case De:
        return "Fragment";
      case je:
        return "Portal";
      case Nt:
        return "Profiler";
      case Ge:
        return "StrictMode";
      case He:
        return "Suspense";
      case nt:
        return "SuspenseList";
    }
    if (typeof e == "object") switch (e.$$typeof) {
      case Yt:
        return (e.displayName || "Context") + ".Consumer";
      case yt:
        return (e._context.displayName || "Context") + ".Provider";
      case ct:
        var t = e.render;
        return e = e.displayName, e || (e = t.displayName || t.name || "", e = e !== "" ? "ForwardRef(" + e + ")" : "ForwardRef"), e;
      case ft:
        return t = e.displayName || null, t !== null ? t : G(e.type) || "Memo";
      case Ie:
        t = e._payload, e = e._init;
        try {
          return G(e(t));
        } catch {
        }
    }
    return null;
  }
  function ne(e) {
    var t = e.type;
    switch (e.tag) {
      case 24:
        return "Cache";
      case 9:
        return (t.displayName || "Context") + ".Consumer";
      case 10:
        return (t._context.displayName || "Context") + ".Provider";
      case 18:
        return "DehydratedFragment";
      case 11:
        return e = t.render, e = e.displayName || e.name || "", t.displayName || (e !== "" ? "ForwardRef(" + e + ")" : "ForwardRef");
      case 7:
        return "Fragment";
      case 5:
        return t;
      case 4:
        return "Portal";
      case 3:
        return "Root";
      case 6:
        return "Text";
      case 16:
        return G(t);
      case 8:
        return t === Ge ? "StrictMode" : "Mode";
      case 22:
        return "Offscreen";
      case 12:
        return "Profiler";
      case 21:
        return "Scope";
      case 13:
        return "Suspense";
      case 19:
        return "SuspenseList";
      case 25:
        return "TracingMarker";
      case 1:
      case 0:
      case 17:
      case 2:
      case 14:
      case 15:
        if (typeof t == "function") return t.displayName || t.name || null;
        if (typeof t == "string") return t;
    }
    return null;
  }
  function q(e) {
    switch (typeof e) {
      case "boolean":
      case "number":
      case "string":
      case "undefined":
        return e;
      case "object":
        return e;
      default:
        return "";
    }
  }
  function ie(e) {
    var t = e.type;
    return (e = e.nodeName) && e.toLowerCase() === "input" && (t === "checkbox" || t === "radio");
  }
  function We(e) {
    var t = ie(e) ? "checked" : "value", n = Object.getOwnPropertyDescriptor(e.constructor.prototype, t), r = "" + e[t];
    if (!e.hasOwnProperty(t) && typeof n < "u" && typeof n.get == "function" && typeof n.set == "function") {
      var l = n.get, u = n.set;
      return Object.defineProperty(e, t, { configurable: !0, get: function() {
        return l.call(this);
      }, set: function(i) {
        r = "" + i, u.call(this, i);
      } }), Object.defineProperty(e, t, { enumerable: n.enumerable }), { getValue: function() {
        return r;
      }, setValue: function(i) {
        r = "" + i;
      }, stopTracking: function() {
        e._valueTracker = null, delete e[t];
      } };
    }
  }
  function kr(e) {
    e._valueTracker || (e._valueTracker = We(e));
  }
  function Li(e) {
    if (!e) return !1;
    var t = e._valueTracker;
    if (!t) return !0;
    var n = t.getValue(), r = "";
    return e && (r = ie(e) ? e.checked ? "true" : "false" : e.value), e = r, e !== n ? (t.setValue(e), !0) : !1;
  }
  function wr(e) {
    if (e = e || (typeof document < "u" ? document : void 0), typeof e > "u") return null;
    try {
      return e.activeElement || e.body;
    } catch {
      return e.body;
    }
  }
  function Ll(e, t) {
    var n = t.checked;
    return N({}, t, { defaultChecked: void 0, defaultValue: void 0, value: void 0, checked: n ?? e._wrapperState.initialChecked });
  }
  function ji(e, t) {
    var n = t.defaultValue == null ? "" : t.defaultValue, r = t.checked != null ? t.checked : t.defaultChecked;
    n = q(t.value != null ? t.value : n), e._wrapperState = { initialChecked: r, initialValue: n, controlled: t.type === "checkbox" || t.type === "radio" ? t.checked != null : t.value != null };
  }
  function Mi(e, t) {
    t = t.checked, t != null && ye(e, "checked", t, !1);
  }
  function jl(e, t) {
    Mi(e, t);
    var n = q(t.value), r = t.type;
    if (n != null) r === "number" ? (n === 0 && e.value === "" || e.value != n) && (e.value = "" + n) : e.value !== "" + n && (e.value = "" + n);
    else if (r === "submit" || r === "reset") {
      e.removeAttribute("value");
      return;
    }
    t.hasOwnProperty("value") ? Ml(e, t.type, n) : t.hasOwnProperty("defaultValue") && Ml(e, t.type, q(t.defaultValue)), t.checked == null && t.defaultChecked != null && (e.defaultChecked = !!t.defaultChecked);
  }
  function Oi(e, t, n) {
    if (t.hasOwnProperty("value") || t.hasOwnProperty("defaultValue")) {
      var r = t.type;
      if (!(r !== "submit" && r !== "reset" || t.value !== void 0 && t.value !== null)) return;
      t = "" + e._wrapperState.initialValue, n || t === e.value || (e.value = t), e.defaultValue = t;
    }
    n = e.name, n !== "" && (e.name = ""), e.defaultChecked = !!e._wrapperState.initialChecked, n !== "" && (e.name = n);
  }
  function Ml(e, t, n) {
    (t !== "number" || wr(e.ownerDocument) !== e) && (n == null ? e.defaultValue = "" + e._wrapperState.initialValue : e.defaultValue !== "" + n && (e.defaultValue = "" + n));
  }
  var Mn = Array.isArray;
  function sn(e, t, n, r) {
    if (e = e.options, t) {
      t = {};
      for (var l = 0; l < n.length; l++) t["$" + n[l]] = !0;
      for (n = 0; n < e.length; n++) l = t.hasOwnProperty("$" + e[n].value), e[n].selected !== l && (e[n].selected = l), l && r && (e[n].defaultSelected = !0);
    } else {
      for (n = "" + q(n), t = null, l = 0; l < e.length; l++) {
        if (e[l].value === n) {
          e[l].selected = !0, r && (e[l].defaultSelected = !0);
          return;
        }
        t !== null || e[l].disabled || (t = e[l]);
      }
      t !== null && (t.selected = !0);
    }
  }
  function Ol(e, t) {
    if (t.dangerouslySetInnerHTML != null) throw Error(c(91));
    return N({}, t, { value: void 0, defaultValue: void 0, children: "" + e._wrapperState.initialValue });
  }
  function Di(e, t) {
    var n = t.value;
    if (n == null) {
      if (n = t.children, t = t.defaultValue, n != null) {
        if (t != null) throw Error(c(92));
        if (Mn(n)) {
          if (1 < n.length) throw Error(c(93));
          n = n[0];
        }
        t = n;
      }
      t == null && (t = ""), n = t;
    }
    e._wrapperState = { initialValue: q(n) };
  }
  function Ii(e, t) {
    var n = q(t.value), r = q(t.defaultValue);
    n != null && (n = "" + n, n !== e.value && (e.value = n), t.defaultValue == null && e.defaultValue !== n && (e.defaultValue = n)), r != null && (e.defaultValue = "" + r);
  }
  function Fi(e) {
    var t = e.textContent;
    t === e._wrapperState.initialValue && t !== "" && t !== null && (e.value = t);
  }
  function Ui(e) {
    switch (e) {
      case "svg":
        return "http://www.w3.org/2000/svg";
      case "math":
        return "http://www.w3.org/1998/Math/MathML";
      default:
        return "http://www.w3.org/1999/xhtml";
    }
  }
  function Dl(e, t) {
    return e == null || e === "http://www.w3.org/1999/xhtml" ? Ui(t) : e === "http://www.w3.org/2000/svg" && t === "foreignObject" ? "http://www.w3.org/1999/xhtml" : e;
  }
  var Sr, Ai = (function(e) {
    return typeof MSApp < "u" && MSApp.execUnsafeLocalFunction ? function(t, n, r, l) {
      MSApp.execUnsafeLocalFunction(function() {
        return e(t, n, r, l);
      });
    } : e;
  })(function(e, t) {
    if (e.namespaceURI !== "http://www.w3.org/2000/svg" || "innerHTML" in e) e.innerHTML = t;
    else {
      for (Sr = Sr || document.createElement("div"), Sr.innerHTML = "<svg>" + t.valueOf().toString() + "</svg>", t = Sr.firstChild; e.firstChild; ) e.removeChild(e.firstChild);
      for (; t.firstChild; ) e.appendChild(t.firstChild);
    }
  });
  function On(e, t) {
    if (t) {
      var n = e.firstChild;
      if (n && n === e.lastChild && n.nodeType === 3) {
        n.nodeValue = t;
        return;
      }
    }
    e.textContent = t;
  }
  var Dn = {
    animationIterationCount: !0,
    aspectRatio: !0,
    borderImageOutset: !0,
    borderImageSlice: !0,
    borderImageWidth: !0,
    boxFlex: !0,
    boxFlexGroup: !0,
    boxOrdinalGroup: !0,
    columnCount: !0,
    columns: !0,
    flex: !0,
    flexGrow: !0,
    flexPositive: !0,
    flexShrink: !0,
    flexNegative: !0,
    flexOrder: !0,
    gridArea: !0,
    gridRow: !0,
    gridRowEnd: !0,
    gridRowSpan: !0,
    gridRowStart: !0,
    gridColumn: !0,
    gridColumnEnd: !0,
    gridColumnSpan: !0,
    gridColumnStart: !0,
    fontWeight: !0,
    lineClamp: !0,
    lineHeight: !0,
    opacity: !0,
    order: !0,
    orphans: !0,
    tabSize: !0,
    widows: !0,
    zIndex: !0,
    zoom: !0,
    fillOpacity: !0,
    floodOpacity: !0,
    stopOpacity: !0,
    strokeDasharray: !0,
    strokeDashoffset: !0,
    strokeMiterlimit: !0,
    strokeOpacity: !0,
    strokeWidth: !0
  }, Aa = ["Webkit", "ms", "Moz", "O"];
  Object.keys(Dn).forEach(function(e) {
    Aa.forEach(function(t) {
      t = t + e.charAt(0).toUpperCase() + e.substring(1), Dn[t] = Dn[e];
    });
  });
  function Vi(e, t, n) {
    return t == null || typeof t == "boolean" || t === "" ? "" : n || typeof t != "number" || t === 0 || Dn.hasOwnProperty(e) && Dn[e] ? ("" + t).trim() : t + "px";
  }
  function $i(e, t) {
    e = e.style;
    for (var n in t) if (t.hasOwnProperty(n)) {
      var r = n.indexOf("--") === 0, l = Vi(n, t[n], r);
      n === "float" && (n = "cssFloat"), r ? e.setProperty(n, l) : e[n] = l;
    }
  }
  var Va = N({ menuitem: !0 }, { area: !0, base: !0, br: !0, col: !0, embed: !0, hr: !0, img: !0, input: !0, keygen: !0, link: !0, meta: !0, param: !0, source: !0, track: !0, wbr: !0 });
  function Il(e, t) {
    if (t) {
      if (Va[e] && (t.children != null || t.dangerouslySetInnerHTML != null)) throw Error(c(137, e));
      if (t.dangerouslySetInnerHTML != null) {
        if (t.children != null) throw Error(c(60));
        if (typeof t.dangerouslySetInnerHTML != "object" || !("__html" in t.dangerouslySetInnerHTML)) throw Error(c(61));
      }
      if (t.style != null && typeof t.style != "object") throw Error(c(62));
    }
  }
  function Fl(e, t) {
    if (e.indexOf("-") === -1) return typeof t.is == "string";
    switch (e) {
      case "annotation-xml":
      case "color-profile":
      case "font-face":
      case "font-face-src":
      case "font-face-uri":
      case "font-face-format":
      case "font-face-name":
      case "missing-glyph":
        return !1;
      default:
        return !0;
    }
  }
  var Ul = null;
  function Al(e) {
    return e = e.target || e.srcElement || window, e.correspondingUseElement && (e = e.correspondingUseElement), e.nodeType === 3 ? e.parentNode : e;
  }
  var Vl = null, an = null, cn = null;
  function Bi(e) {
    if (e = rr(e)) {
      if (typeof Vl != "function") throw Error(c(280));
      var t = e.stateNode;
      t && (t = Wr(t), Vl(e.stateNode, e.type, t));
    }
  }
  function Hi(e) {
    an ? cn ? cn.push(e) : cn = [e] : an = e;
  }
  function Wi() {
    if (an) {
      var e = an, t = cn;
      if (cn = an = null, Bi(e), t) for (e = 0; e < t.length; e++) Bi(t[e]);
    }
  }
  function Qi(e, t) {
    return e(t);
  }
  function Ki() {
  }
  var $l = !1;
  function Yi(e, t, n) {
    if ($l) return e(t, n);
    $l = !0;
    try {
      return Qi(e, t, n);
    } finally {
      $l = !1, (an !== null || cn !== null) && (Ki(), Wi());
    }
  }
  function In(e, t) {
    var n = e.stateNode;
    if (n === null) return null;
    var r = Wr(n);
    if (r === null) return null;
    n = r[t];
    e: switch (t) {
      case "onClick":
      case "onClickCapture":
      case "onDoubleClick":
      case "onDoubleClickCapture":
      case "onMouseDown":
      case "onMouseDownCapture":
      case "onMouseMove":
      case "onMouseMoveCapture":
      case "onMouseUp":
      case "onMouseUpCapture":
      case "onMouseEnter":
        (r = !r.disabled) || (e = e.type, r = !(e === "button" || e === "input" || e === "select" || e === "textarea")), e = !r;
        break e;
      default:
        e = !1;
    }
    if (e) return null;
    if (n && typeof n != "function") throw Error(c(231, t, typeof n));
    return n;
  }
  var Bl = !1;
  if (ee) try {
    var Fn = {};
    Object.defineProperty(Fn, "passive", { get: function() {
      Bl = !0;
    } }), window.addEventListener("test", Fn, Fn), window.removeEventListener("test", Fn, Fn);
  } catch {
    Bl = !1;
  }
  function $a(e, t, n, r, l, u, i, o, s) {
    var h = Array.prototype.slice.call(arguments, 3);
    try {
      t.apply(n, h);
    } catch (k) {
      this.onError(k);
    }
  }
  var Un = !1, _r = null, xr = !1, Hl = null, Ba = { onError: function(e) {
    Un = !0, _r = e;
  } };
  function Ha(e, t, n, r, l, u, i, o, s) {
    Un = !1, _r = null, $a.apply(Ba, arguments);
  }
  function Wa(e, t, n, r, l, u, i, o, s) {
    if (Ha.apply(this, arguments), Un) {
      if (Un) {
        var h = _r;
        Un = !1, _r = null;
      } else throw Error(c(198));
      xr || (xr = !0, Hl = h);
    }
  }
  function Xt(e) {
    var t = e, n = e;
    if (e.alternate) for (; t.return; ) t = t.return;
    else {
      e = t;
      do
        t = e, (t.flags & 4098) !== 0 && (n = t.return), e = t.return;
      while (e);
    }
    return t.tag === 3 ? n : null;
  }
  function Xi(e) {
    if (e.tag === 13) {
      var t = e.memoizedState;
      if (t === null && (e = e.alternate, e !== null && (t = e.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function Gi(e) {
    if (Xt(e) !== e) throw Error(c(188));
  }
  function Qa(e) {
    var t = e.alternate;
    if (!t) {
      if (t = Xt(e), t === null) throw Error(c(188));
      return t !== e ? null : e;
    }
    for (var n = e, r = t; ; ) {
      var l = n.return;
      if (l === null) break;
      var u = l.alternate;
      if (u === null) {
        if (r = l.return, r !== null) {
          n = r;
          continue;
        }
        break;
      }
      if (l.child === u.child) {
        for (u = l.child; u; ) {
          if (u === n) return Gi(l), e;
          if (u === r) return Gi(l), t;
          u = u.sibling;
        }
        throw Error(c(188));
      }
      if (n.return !== r.return) n = l, r = u;
      else {
        for (var i = !1, o = l.child; o; ) {
          if (o === n) {
            i = !0, n = l, r = u;
            break;
          }
          if (o === r) {
            i = !0, r = l, n = u;
            break;
          }
          o = o.sibling;
        }
        if (!i) {
          for (o = u.child; o; ) {
            if (o === n) {
              i = !0, n = u, r = l;
              break;
            }
            if (o === r) {
              i = !0, r = u, n = l;
              break;
            }
            o = o.sibling;
          }
          if (!i) throw Error(c(189));
        }
      }
      if (n.alternate !== r) throw Error(c(190));
    }
    if (n.tag !== 3) throw Error(c(188));
    return n.stateNode.current === n ? e : t;
  }
  function Zi(e) {
    return e = Qa(e), e !== null ? Ji(e) : null;
  }
  function Ji(e) {
    if (e.tag === 5 || e.tag === 6) return e;
    for (e = e.child; e !== null; ) {
      var t = Ji(e);
      if (t !== null) return t;
      e = e.sibling;
    }
    return null;
  }
  var qi = v.unstable_scheduleCallback, bi = v.unstable_cancelCallback, Ka = v.unstable_shouldYield, Ya = v.unstable_requestPaint, he = v.unstable_now, Xa = v.unstable_getCurrentPriorityLevel, Wl = v.unstable_ImmediatePriority, eo = v.unstable_UserBlockingPriority, Er = v.unstable_NormalPriority, Ga = v.unstable_LowPriority, to = v.unstable_IdlePriority, Cr = null, dt = null;
  function Za(e) {
    if (dt && typeof dt.onCommitFiberRoot == "function") try {
      dt.onCommitFiberRoot(Cr, e, void 0, (e.current.flags & 128) === 128);
    } catch {
    }
  }
  var rt = Math.clz32 ? Math.clz32 : ba, Ja = Math.log, qa = Math.LN2;
  function ba(e) {
    return e >>>= 0, e === 0 ? 32 : 31 - (Ja(e) / qa | 0) | 0;
  }
  var Nr = 64, Pr = 4194304;
  function An(e) {
    switch (e & -e) {
      case 1:
        return 1;
      case 2:
        return 2;
      case 4:
        return 4;
      case 8:
        return 8;
      case 16:
        return 16;
      case 32:
        return 32;
      case 64:
      case 128:
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return e & 4194240;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
      case 67108864:
        return e & 130023424;
      case 134217728:
        return 134217728;
      case 268435456:
        return 268435456;
      case 536870912:
        return 536870912;
      case 1073741824:
        return 1073741824;
      default:
        return e;
    }
  }
  function zr(e, t) {
    var n = e.pendingLanes;
    if (n === 0) return 0;
    var r = 0, l = e.suspendedLanes, u = e.pingedLanes, i = n & 268435455;
    if (i !== 0) {
      var o = i & ~l;
      o !== 0 ? r = An(o) : (u &= i, u !== 0 && (r = An(u)));
    } else i = n & ~l, i !== 0 ? r = An(i) : u !== 0 && (r = An(u));
    if (r === 0) return 0;
    if (t !== 0 && t !== r && (t & l) === 0 && (l = r & -r, u = t & -t, l >= u || l === 16 && (u & 4194240) !== 0)) return t;
    if ((r & 4) !== 0 && (r |= n & 16), t = e.entangledLanes, t !== 0) for (e = e.entanglements, t &= r; 0 < t; ) n = 31 - rt(t), l = 1 << n, r |= e[n], t &= ~l;
    return r;
  }
  function ec(e, t) {
    switch (e) {
      case 1:
      case 2:
      case 4:
        return t + 250;
      case 8:
      case 16:
      case 32:
      case 64:
      case 128:
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return t + 5e3;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
      case 67108864:
        return -1;
      case 134217728:
      case 268435456:
      case 536870912:
      case 1073741824:
        return -1;
      default:
        return -1;
    }
  }
  function tc(e, t) {
    for (var n = e.suspendedLanes, r = e.pingedLanes, l = e.expirationTimes, u = e.pendingLanes; 0 < u; ) {
      var i = 31 - rt(u), o = 1 << i, s = l[i];
      s === -1 ? ((o & n) === 0 || (o & r) !== 0) && (l[i] = ec(o, t)) : s <= t && (e.expiredLanes |= o), u &= ~o;
    }
  }
  function Ql(e) {
    return e = e.pendingLanes & -1073741825, e !== 0 ? e : e & 1073741824 ? 1073741824 : 0;
  }
  function no() {
    var e = Nr;
    return Nr <<= 1, (Nr & 4194240) === 0 && (Nr = 64), e;
  }
  function Kl(e) {
    for (var t = [], n = 0; 31 > n; n++) t.push(e);
    return t;
  }
  function Vn(e, t, n) {
    e.pendingLanes |= t, t !== 536870912 && (e.suspendedLanes = 0, e.pingedLanes = 0), e = e.eventTimes, t = 31 - rt(t), e[t] = n;
  }
  function nc(e, t) {
    var n = e.pendingLanes & ~t;
    e.pendingLanes = t, e.suspendedLanes = 0, e.pingedLanes = 0, e.expiredLanes &= t, e.mutableReadLanes &= t, e.entangledLanes &= t, t = e.entanglements;
    var r = e.eventTimes;
    for (e = e.expirationTimes; 0 < n; ) {
      var l = 31 - rt(n), u = 1 << l;
      t[l] = 0, r[l] = -1, e[l] = -1, n &= ~u;
    }
  }
  function Yl(e, t) {
    var n = e.entangledLanes |= t;
    for (e = e.entanglements; n; ) {
      var r = 31 - rt(n), l = 1 << r;
      l & t | e[r] & t && (e[r] |= t), n &= ~l;
    }
  }
  var b = 0;
  function ro(e) {
    return e &= -e, 1 < e ? 4 < e ? (e & 268435455) !== 0 ? 16 : 536870912 : 4 : 1;
  }
  var lo, Xl, uo, io, oo, Gl = !1, Tr = [], Pt = null, zt = null, Tt = null, $n = /* @__PURE__ */ new Map(), Bn = /* @__PURE__ */ new Map(), Rt = [], rc = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");
  function so(e, t) {
    switch (e) {
      case "focusin":
      case "focusout":
        Pt = null;
        break;
      case "dragenter":
      case "dragleave":
        zt = null;
        break;
      case "mouseover":
      case "mouseout":
        Tt = null;
        break;
      case "pointerover":
      case "pointerout":
        $n.delete(t.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        Bn.delete(t.pointerId);
    }
  }
  function Hn(e, t, n, r, l, u) {
    return e === null || e.nativeEvent !== u ? (e = { blockedOn: t, domEventName: n, eventSystemFlags: r, nativeEvent: u, targetContainers: [l] }, t !== null && (t = rr(t), t !== null && Xl(t)), e) : (e.eventSystemFlags |= r, t = e.targetContainers, l !== null && t.indexOf(l) === -1 && t.push(l), e);
  }
  function lc(e, t, n, r, l) {
    switch (t) {
      case "focusin":
        return Pt = Hn(Pt, e, t, n, r, l), !0;
      case "dragenter":
        return zt = Hn(zt, e, t, n, r, l), !0;
      case "mouseover":
        return Tt = Hn(Tt, e, t, n, r, l), !0;
      case "pointerover":
        var u = l.pointerId;
        return $n.set(u, Hn($n.get(u) || null, e, t, n, r, l)), !0;
      case "gotpointercapture":
        return u = l.pointerId, Bn.set(u, Hn(Bn.get(u) || null, e, t, n, r, l)), !0;
    }
    return !1;
  }
  function ao(e) {
    var t = Gt(e.target);
    if (t !== null) {
      var n = Xt(t);
      if (n !== null) {
        if (t = n.tag, t === 13) {
          if (t = Xi(n), t !== null) {
            e.blockedOn = t, oo(e.priority, function() {
              uo(n);
            });
            return;
          }
        } else if (t === 3 && n.stateNode.current.memoizedState.isDehydrated) {
          e.blockedOn = n.tag === 3 ? n.stateNode.containerInfo : null;
          return;
        }
      }
    }
    e.blockedOn = null;
  }
  function Rr(e) {
    if (e.blockedOn !== null) return !1;
    for (var t = e.targetContainers; 0 < t.length; ) {
      var n = Jl(e.domEventName, e.eventSystemFlags, t[0], e.nativeEvent);
      if (n === null) {
        n = e.nativeEvent;
        var r = new n.constructor(n.type, n);
        Ul = r, n.target.dispatchEvent(r), Ul = null;
      } else return t = rr(n), t !== null && Xl(t), e.blockedOn = n, !1;
      t.shift();
    }
    return !0;
  }
  function co(e, t, n) {
    Rr(e) && n.delete(t);
  }
  function uc() {
    Gl = !1, Pt !== null && Rr(Pt) && (Pt = null), zt !== null && Rr(zt) && (zt = null), Tt !== null && Rr(Tt) && (Tt = null), $n.forEach(co), Bn.forEach(co);
  }
  function Wn(e, t) {
    e.blockedOn === t && (e.blockedOn = null, Gl || (Gl = !0, v.unstable_scheduleCallback(v.unstable_NormalPriority, uc)));
  }
  function Qn(e) {
    function t(l) {
      return Wn(l, e);
    }
    if (0 < Tr.length) {
      Wn(Tr[0], e);
      for (var n = 1; n < Tr.length; n++) {
        var r = Tr[n];
        r.blockedOn === e && (r.blockedOn = null);
      }
    }
    for (Pt !== null && Wn(Pt, e), zt !== null && Wn(zt, e), Tt !== null && Wn(Tt, e), $n.forEach(t), Bn.forEach(t), n = 0; n < Rt.length; n++) r = Rt[n], r.blockedOn === e && (r.blockedOn = null);
    for (; 0 < Rt.length && (n = Rt[0], n.blockedOn === null); ) ao(n), n.blockedOn === null && Rt.shift();
  }
  var fn = ge.ReactCurrentBatchConfig, Lr = !0;
  function ic(e, t, n, r) {
    var l = b, u = fn.transition;
    fn.transition = null;
    try {
      b = 1, Zl(e, t, n, r);
    } finally {
      b = l, fn.transition = u;
    }
  }
  function oc(e, t, n, r) {
    var l = b, u = fn.transition;
    fn.transition = null;
    try {
      b = 4, Zl(e, t, n, r);
    } finally {
      b = l, fn.transition = u;
    }
  }
  function Zl(e, t, n, r) {
    if (Lr) {
      var l = Jl(e, t, n, r);
      if (l === null) hu(e, t, r, jr, n), so(e, r);
      else if (lc(l, e, t, n, r)) r.stopPropagation();
      else if (so(e, r), t & 4 && -1 < rc.indexOf(e)) {
        for (; l !== null; ) {
          var u = rr(l);
          if (u !== null && lo(u), u = Jl(e, t, n, r), u === null && hu(e, t, r, jr, n), u === l) break;
          l = u;
        }
        l !== null && r.stopPropagation();
      } else hu(e, t, r, null, n);
    }
  }
  var jr = null;
  function Jl(e, t, n, r) {
    if (jr = null, e = Al(r), e = Gt(e), e !== null) if (t = Xt(e), t === null) e = null;
    else if (n = t.tag, n === 13) {
      if (e = Xi(t), e !== null) return e;
      e = null;
    } else if (n === 3) {
      if (t.stateNode.current.memoizedState.isDehydrated) return t.tag === 3 ? t.stateNode.containerInfo : null;
      e = null;
    } else t !== e && (e = null);
    return jr = e, null;
  }
  function fo(e) {
    switch (e) {
      case "cancel":
      case "click":
      case "close":
      case "contextmenu":
      case "copy":
      case "cut":
      case "auxclick":
      case "dblclick":
      case "dragend":
      case "dragstart":
      case "drop":
      case "focusin":
      case "focusout":
      case "input":
      case "invalid":
      case "keydown":
      case "keypress":
      case "keyup":
      case "mousedown":
      case "mouseup":
      case "paste":
      case "pause":
      case "play":
      case "pointercancel":
      case "pointerdown":
      case "pointerup":
      case "ratechange":
      case "reset":
      case "resize":
      case "seeked":
      case "submit":
      case "touchcancel":
      case "touchend":
      case "touchstart":
      case "volumechange":
      case "change":
      case "selectionchange":
      case "textInput":
      case "compositionstart":
      case "compositionend":
      case "compositionupdate":
      case "beforeblur":
      case "afterblur":
      case "beforeinput":
      case "blur":
      case "fullscreenchange":
      case "focus":
      case "hashchange":
      case "popstate":
      case "select":
      case "selectstart":
        return 1;
      case "drag":
      case "dragenter":
      case "dragexit":
      case "dragleave":
      case "dragover":
      case "mousemove":
      case "mouseout":
      case "mouseover":
      case "pointermove":
      case "pointerout":
      case "pointerover":
      case "scroll":
      case "toggle":
      case "touchmove":
      case "wheel":
      case "mouseenter":
      case "mouseleave":
      case "pointerenter":
      case "pointerleave":
        return 4;
      case "message":
        switch (Xa()) {
          case Wl:
            return 1;
          case eo:
            return 4;
          case Er:
          case Ga:
            return 16;
          case to:
            return 536870912;
          default:
            return 16;
        }
      default:
        return 16;
    }
  }
  var Lt = null, ql = null, Mr = null;
  function po() {
    if (Mr) return Mr;
    var e, t = ql, n = t.length, r, l = "value" in Lt ? Lt.value : Lt.textContent, u = l.length;
    for (e = 0; e < n && t[e] === l[e]; e++) ;
    var i = n - e;
    for (r = 1; r <= i && t[n - r] === l[u - r]; r++) ;
    return Mr = l.slice(e, 1 < r ? 1 - r : void 0);
  }
  function Or(e) {
    var t = e.keyCode;
    return "charCode" in e ? (e = e.charCode, e === 0 && t === 13 && (e = 13)) : e = t, e === 10 && (e = 13), 32 <= e || e === 13 ? e : 0;
  }
  function Dr() {
    return !0;
  }
  function ho() {
    return !1;
  }
  function Qe(e) {
    function t(n, r, l, u, i) {
      this._reactName = n, this._targetInst = l, this.type = r, this.nativeEvent = u, this.target = i, this.currentTarget = null;
      for (var o in e) e.hasOwnProperty(o) && (n = e[o], this[o] = n ? n(u) : u[o]);
      return this.isDefaultPrevented = (u.defaultPrevented != null ? u.defaultPrevented : u.returnValue === !1) ? Dr : ho, this.isPropagationStopped = ho, this;
    }
    return N(t.prototype, { preventDefault: function() {
      this.defaultPrevented = !0;
      var n = this.nativeEvent;
      n && (n.preventDefault ? n.preventDefault() : typeof n.returnValue != "unknown" && (n.returnValue = !1), this.isDefaultPrevented = Dr);
    }, stopPropagation: function() {
      var n = this.nativeEvent;
      n && (n.stopPropagation ? n.stopPropagation() : typeof n.cancelBubble != "unknown" && (n.cancelBubble = !0), this.isPropagationStopped = Dr);
    }, persist: function() {
    }, isPersistent: Dr }), t;
  }
  var dn = { eventPhase: 0, bubbles: 0, cancelable: 0, timeStamp: function(e) {
    return e.timeStamp || Date.now();
  }, defaultPrevented: 0, isTrusted: 0 }, bl = Qe(dn), Kn = N({}, dn, { view: 0, detail: 0 }), sc = Qe(Kn), eu, tu, Yn, Ir = N({}, Kn, { screenX: 0, screenY: 0, clientX: 0, clientY: 0, pageX: 0, pageY: 0, ctrlKey: 0, shiftKey: 0, altKey: 0, metaKey: 0, getModifierState: ru, button: 0, buttons: 0, relatedTarget: function(e) {
    return e.relatedTarget === void 0 ? e.fromElement === e.srcElement ? e.toElement : e.fromElement : e.relatedTarget;
  }, movementX: function(e) {
    return "movementX" in e ? e.movementX : (e !== Yn && (Yn && e.type === "mousemove" ? (eu = e.screenX - Yn.screenX, tu = e.screenY - Yn.screenY) : tu = eu = 0, Yn = e), eu);
  }, movementY: function(e) {
    return "movementY" in e ? e.movementY : tu;
  } }), mo = Qe(Ir), ac = N({}, Ir, { dataTransfer: 0 }), cc = Qe(ac), fc = N({}, Kn, { relatedTarget: 0 }), nu = Qe(fc), dc = N({}, dn, { animationName: 0, elapsedTime: 0, pseudoElement: 0 }), pc = Qe(dc), hc = N({}, dn, { clipboardData: function(e) {
    return "clipboardData" in e ? e.clipboardData : window.clipboardData;
  } }), mc = Qe(hc), vc = N({}, dn, { data: 0 }), vo = Qe(vc), yc = {
    Esc: "Escape",
    Spacebar: " ",
    Left: "ArrowLeft",
    Up: "ArrowUp",
    Right: "ArrowRight",
    Down: "ArrowDown",
    Del: "Delete",
    Win: "OS",
    Menu: "ContextMenu",
    Apps: "ContextMenu",
    Scroll: "ScrollLock",
    MozPrintableKey: "Unidentified"
  }, gc = {
    8: "Backspace",
    9: "Tab",
    12: "Clear",
    13: "Enter",
    16: "Shift",
    17: "Control",
    18: "Alt",
    19: "Pause",
    20: "CapsLock",
    27: "Escape",
    32: " ",
    33: "PageUp",
    34: "PageDown",
    35: "End",
    36: "Home",
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    45: "Insert",
    46: "Delete",
    112: "F1",
    113: "F2",
    114: "F3",
    115: "F4",
    116: "F5",
    117: "F6",
    118: "F7",
    119: "F8",
    120: "F9",
    121: "F10",
    122: "F11",
    123: "F12",
    144: "NumLock",
    145: "ScrollLock",
    224: "Meta"
  }, kc = { Alt: "altKey", Control: "ctrlKey", Meta: "metaKey", Shift: "shiftKey" };
  function wc(e) {
    var t = this.nativeEvent;
    return t.getModifierState ? t.getModifierState(e) : (e = kc[e]) ? !!t[e] : !1;
  }
  function ru() {
    return wc;
  }
  var Sc = N({}, Kn, { key: function(e) {
    if (e.key) {
      var t = yc[e.key] || e.key;
      if (t !== "Unidentified") return t;
    }
    return e.type === "keypress" ? (e = Or(e), e === 13 ? "Enter" : String.fromCharCode(e)) : e.type === "keydown" || e.type === "keyup" ? gc[e.keyCode] || "Unidentified" : "";
  }, code: 0, location: 0, ctrlKey: 0, shiftKey: 0, altKey: 0, metaKey: 0, repeat: 0, locale: 0, getModifierState: ru, charCode: function(e) {
    return e.type === "keypress" ? Or(e) : 0;
  }, keyCode: function(e) {
    return e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
  }, which: function(e) {
    return e.type === "keypress" ? Or(e) : e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
  } }), _c = Qe(Sc), xc = N({}, Ir, { pointerId: 0, width: 0, height: 0, pressure: 0, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0, pointerType: 0, isPrimary: 0 }), yo = Qe(xc), Ec = N({}, Kn, { touches: 0, targetTouches: 0, changedTouches: 0, altKey: 0, metaKey: 0, ctrlKey: 0, shiftKey: 0, getModifierState: ru }), Cc = Qe(Ec), Nc = N({}, dn, { propertyName: 0, elapsedTime: 0, pseudoElement: 0 }), Pc = Qe(Nc), zc = N({}, Ir, {
    deltaX: function(e) {
      return "deltaX" in e ? e.deltaX : "wheelDeltaX" in e ? -e.wheelDeltaX : 0;
    },
    deltaY: function(e) {
      return "deltaY" in e ? e.deltaY : "wheelDeltaY" in e ? -e.wheelDeltaY : "wheelDelta" in e ? -e.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), Tc = Qe(zc), Rc = [9, 13, 27, 32], lu = ee && "CompositionEvent" in window, Xn = null;
  ee && "documentMode" in document && (Xn = document.documentMode);
  var Lc = ee && "TextEvent" in window && !Xn, go = ee && (!lu || Xn && 8 < Xn && 11 >= Xn), ko = " ", wo = !1;
  function So(e, t) {
    switch (e) {
      case "keyup":
        return Rc.indexOf(t.keyCode) !== -1;
      case "keydown":
        return t.keyCode !== 229;
      case "keypress":
      case "mousedown":
      case "focusout":
        return !0;
      default:
        return !1;
    }
  }
  function _o(e) {
    return e = e.detail, typeof e == "object" && "data" in e ? e.data : null;
  }
  var pn = !1;
  function jc(e, t) {
    switch (e) {
      case "compositionend":
        return _o(t);
      case "keypress":
        return t.which !== 32 ? null : (wo = !0, ko);
      case "textInput":
        return e = t.data, e === ko && wo ? null : e;
      default:
        return null;
    }
  }
  function Mc(e, t) {
    if (pn) return e === "compositionend" || !lu && So(e, t) ? (e = po(), Mr = ql = Lt = null, pn = !1, e) : null;
    switch (e) {
      case "paste":
        return null;
      case "keypress":
        if (!(t.ctrlKey || t.altKey || t.metaKey) || t.ctrlKey && t.altKey) {
          if (t.char && 1 < t.char.length) return t.char;
          if (t.which) return String.fromCharCode(t.which);
        }
        return null;
      case "compositionend":
        return go && t.locale !== "ko" ? null : t.data;
      default:
        return null;
    }
  }
  var Oc = { color: !0, date: !0, datetime: !0, "datetime-local": !0, email: !0, month: !0, number: !0, password: !0, range: !0, search: !0, tel: !0, text: !0, time: !0, url: !0, week: !0 };
  function xo(e) {
    var t = e && e.nodeName && e.nodeName.toLowerCase();
    return t === "input" ? !!Oc[e.type] : t === "textarea";
  }
  function Eo(e, t, n, r) {
    Hi(r), t = $r(t, "onChange"), 0 < t.length && (n = new bl("onChange", "change", null, n, r), e.push({ event: n, listeners: t }));
  }
  var Gn = null, Zn = null;
  function Dc(e) {
    Bo(e, 0);
  }
  function Fr(e) {
    var t = gn(e);
    if (Li(t)) return e;
  }
  function Ic(e, t) {
    if (e === "change") return t;
  }
  var Co = !1;
  if (ee) {
    var uu;
    if (ee) {
      var iu = "oninput" in document;
      if (!iu) {
        var No = document.createElement("div");
        No.setAttribute("oninput", "return;"), iu = typeof No.oninput == "function";
      }
      uu = iu;
    } else uu = !1;
    Co = uu && (!document.documentMode || 9 < document.documentMode);
  }
  function Po() {
    Gn && (Gn.detachEvent("onpropertychange", zo), Zn = Gn = null);
  }
  function zo(e) {
    if (e.propertyName === "value" && Fr(Zn)) {
      var t = [];
      Eo(t, Zn, e, Al(e)), Yi(Dc, t);
    }
  }
  function Fc(e, t, n) {
    e === "focusin" ? (Po(), Gn = t, Zn = n, Gn.attachEvent("onpropertychange", zo)) : e === "focusout" && Po();
  }
  function Uc(e) {
    if (e === "selectionchange" || e === "keyup" || e === "keydown") return Fr(Zn);
  }
  function Ac(e, t) {
    if (e === "click") return Fr(t);
  }
  function Vc(e, t) {
    if (e === "input" || e === "change") return Fr(t);
  }
  function $c(e, t) {
    return e === t && (e !== 0 || 1 / e === 1 / t) || e !== e && t !== t;
  }
  var lt = typeof Object.is == "function" ? Object.is : $c;
  function Jn(e, t) {
    if (lt(e, t)) return !0;
    if (typeof e != "object" || e === null || typeof t != "object" || t === null) return !1;
    var n = Object.keys(e), r = Object.keys(t);
    if (n.length !== r.length) return !1;
    for (r = 0; r < n.length; r++) {
      var l = n[r];
      if (!Q.call(t, l) || !lt(e[l], t[l])) return !1;
    }
    return !0;
  }
  function To(e) {
    for (; e && e.firstChild; ) e = e.firstChild;
    return e;
  }
  function Ro(e, t) {
    var n = To(e);
    e = 0;
    for (var r; n; ) {
      if (n.nodeType === 3) {
        if (r = e + n.textContent.length, e <= t && r >= t) return { node: n, offset: t - e };
        e = r;
      }
      e: {
        for (; n; ) {
          if (n.nextSibling) {
            n = n.nextSibling;
            break e;
          }
          n = n.parentNode;
        }
        n = void 0;
      }
      n = To(n);
    }
  }
  function Lo(e, t) {
    return e && t ? e === t ? !0 : e && e.nodeType === 3 ? !1 : t && t.nodeType === 3 ? Lo(e, t.parentNode) : "contains" in e ? e.contains(t) : e.compareDocumentPosition ? !!(e.compareDocumentPosition(t) & 16) : !1 : !1;
  }
  function jo() {
    for (var e = window, t = wr(); t instanceof e.HTMLIFrameElement; ) {
      try {
        var n = typeof t.contentWindow.location.href == "string";
      } catch {
        n = !1;
      }
      if (n) e = t.contentWindow;
      else break;
      t = wr(e.document);
    }
    return t;
  }
  function ou(e) {
    var t = e && e.nodeName && e.nodeName.toLowerCase();
    return t && (t === "input" && (e.type === "text" || e.type === "search" || e.type === "tel" || e.type === "url" || e.type === "password") || t === "textarea" || e.contentEditable === "true");
  }
  function Bc(e) {
    var t = jo(), n = e.focusedElem, r = e.selectionRange;
    if (t !== n && n && n.ownerDocument && Lo(n.ownerDocument.documentElement, n)) {
      if (r !== null && ou(n)) {
        if (t = r.start, e = r.end, e === void 0 && (e = t), "selectionStart" in n) n.selectionStart = t, n.selectionEnd = Math.min(e, n.value.length);
        else if (e = (t = n.ownerDocument || document) && t.defaultView || window, e.getSelection) {
          e = e.getSelection();
          var l = n.textContent.length, u = Math.min(r.start, l);
          r = r.end === void 0 ? u : Math.min(r.end, l), !e.extend && u > r && (l = r, r = u, u = l), l = Ro(n, u);
          var i = Ro(
            n,
            r
          );
          l && i && (e.rangeCount !== 1 || e.anchorNode !== l.node || e.anchorOffset !== l.offset || e.focusNode !== i.node || e.focusOffset !== i.offset) && (t = t.createRange(), t.setStart(l.node, l.offset), e.removeAllRanges(), u > r ? (e.addRange(t), e.extend(i.node, i.offset)) : (t.setEnd(i.node, i.offset), e.addRange(t)));
        }
      }
      for (t = [], e = n; e = e.parentNode; ) e.nodeType === 1 && t.push({ element: e, left: e.scrollLeft, top: e.scrollTop });
      for (typeof n.focus == "function" && n.focus(), n = 0; n < t.length; n++) e = t[n], e.element.scrollLeft = e.left, e.element.scrollTop = e.top;
    }
  }
  var Hc = ee && "documentMode" in document && 11 >= document.documentMode, hn = null, su = null, qn = null, au = !1;
  function Mo(e, t, n) {
    var r = n.window === n ? n.document : n.nodeType === 9 ? n : n.ownerDocument;
    au || hn == null || hn !== wr(r) || (r = hn, "selectionStart" in r && ou(r) ? r = { start: r.selectionStart, end: r.selectionEnd } : (r = (r.ownerDocument && r.ownerDocument.defaultView || window).getSelection(), r = { anchorNode: r.anchorNode, anchorOffset: r.anchorOffset, focusNode: r.focusNode, focusOffset: r.focusOffset }), qn && Jn(qn, r) || (qn = r, r = $r(su, "onSelect"), 0 < r.length && (t = new bl("onSelect", "select", null, t, n), e.push({ event: t, listeners: r }), t.target = hn)));
  }
  function Ur(e, t) {
    var n = {};
    return n[e.toLowerCase()] = t.toLowerCase(), n["Webkit" + e] = "webkit" + t, n["Moz" + e] = "moz" + t, n;
  }
  var mn = { animationend: Ur("Animation", "AnimationEnd"), animationiteration: Ur("Animation", "AnimationIteration"), animationstart: Ur("Animation", "AnimationStart"), transitionend: Ur("Transition", "TransitionEnd") }, cu = {}, Oo = {};
  ee && (Oo = document.createElement("div").style, "AnimationEvent" in window || (delete mn.animationend.animation, delete mn.animationiteration.animation, delete mn.animationstart.animation), "TransitionEvent" in window || delete mn.transitionend.transition);
  function Ar(e) {
    if (cu[e]) return cu[e];
    if (!mn[e]) return e;
    var t = mn[e], n;
    for (n in t) if (t.hasOwnProperty(n) && n in Oo) return cu[e] = t[n];
    return e;
  }
  var Do = Ar("animationend"), Io = Ar("animationiteration"), Fo = Ar("animationstart"), Uo = Ar("transitionend"), Ao = /* @__PURE__ */ new Map(), Vo = "abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");
  function jt(e, t) {
    Ao.set(e, t), H(t, [e]);
  }
  for (var fu = 0; fu < Vo.length; fu++) {
    var du = Vo[fu], Wc = du.toLowerCase(), Qc = du[0].toUpperCase() + du.slice(1);
    jt(Wc, "on" + Qc);
  }
  jt(Do, "onAnimationEnd"), jt(Io, "onAnimationIteration"), jt(Fo, "onAnimationStart"), jt("dblclick", "onDoubleClick"), jt("focusin", "onFocus"), jt("focusout", "onBlur"), jt(Uo, "onTransitionEnd"), Y("onMouseEnter", ["mouseout", "mouseover"]), Y("onMouseLeave", ["mouseout", "mouseover"]), Y("onPointerEnter", ["pointerout", "pointerover"]), Y("onPointerLeave", ["pointerout", "pointerover"]), H("onChange", "change click focusin focusout input keydown keyup selectionchange".split(" ")), H("onSelect", "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" ")), H("onBeforeInput", ["compositionend", "keypress", "textInput", "paste"]), H("onCompositionEnd", "compositionend focusout keydown keypress keyup mousedown".split(" ")), H("onCompositionStart", "compositionstart focusout keydown keypress keyup mousedown".split(" ")), H("onCompositionUpdate", "compositionupdate focusout keydown keypress keyup mousedown".split(" "));
  var bn = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "), Kc = new Set("cancel close invalid load scroll toggle".split(" ").concat(bn));
  function $o(e, t, n) {
    var r = e.type || "unknown-event";
    e.currentTarget = n, Wa(r, t, void 0, e), e.currentTarget = null;
  }
  function Bo(e, t) {
    t = (t & 4) !== 0;
    for (var n = 0; n < e.length; n++) {
      var r = e[n], l = r.event;
      r = r.listeners;
      e: {
        var u = void 0;
        if (t) for (var i = r.length - 1; 0 <= i; i--) {
          var o = r[i], s = o.instance, h = o.currentTarget;
          if (o = o.listener, s !== u && l.isPropagationStopped()) break e;
          $o(l, o, h), u = s;
        }
        else for (i = 0; i < r.length; i++) {
          if (o = r[i], s = o.instance, h = o.currentTarget, o = o.listener, s !== u && l.isPropagationStopped()) break e;
          $o(l, o, h), u = s;
        }
      }
    }
    if (xr) throw e = Hl, xr = !1, Hl = null, e;
  }
  function le(e, t) {
    var n = t[wu];
    n === void 0 && (n = t[wu] = /* @__PURE__ */ new Set());
    var r = e + "__bubble";
    n.has(r) || (Ho(t, e, 2, !1), n.add(r));
  }
  function pu(e, t, n) {
    var r = 0;
    t && (r |= 4), Ho(n, e, r, t);
  }
  var Vr = "_reactListening" + Math.random().toString(36).slice(2);
  function er(e) {
    if (!e[Vr]) {
      e[Vr] = !0, T.forEach(function(n) {
        n !== "selectionchange" && (Kc.has(n) || pu(n, !1, e), pu(n, !0, e));
      });
      var t = e.nodeType === 9 ? e : e.ownerDocument;
      t === null || t[Vr] || (t[Vr] = !0, pu("selectionchange", !1, t));
    }
  }
  function Ho(e, t, n, r) {
    switch (fo(t)) {
      case 1:
        var l = ic;
        break;
      case 4:
        l = oc;
        break;
      default:
        l = Zl;
    }
    n = l.bind(null, t, n, e), l = void 0, !Bl || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (l = !0), r ? l !== void 0 ? e.addEventListener(t, n, { capture: !0, passive: l }) : e.addEventListener(t, n, !0) : l !== void 0 ? e.addEventListener(t, n, { passive: l }) : e.addEventListener(t, n, !1);
  }
  function hu(e, t, n, r, l) {
    var u = r;
    if ((t & 1) === 0 && (t & 2) === 0 && r !== null) e: for (; ; ) {
      if (r === null) return;
      var i = r.tag;
      if (i === 3 || i === 4) {
        var o = r.stateNode.containerInfo;
        if (o === l || o.nodeType === 8 && o.parentNode === l) break;
        if (i === 4) for (i = r.return; i !== null; ) {
          var s = i.tag;
          if ((s === 3 || s === 4) && (s = i.stateNode.containerInfo, s === l || s.nodeType === 8 && s.parentNode === l)) return;
          i = i.return;
        }
        for (; o !== null; ) {
          if (i = Gt(o), i === null) return;
          if (s = i.tag, s === 5 || s === 6) {
            r = u = i;
            continue e;
          }
          o = o.parentNode;
        }
      }
      r = r.return;
    }
    Yi(function() {
      var h = u, k = Al(n), w = [];
      e: {
        var y = Ao.get(e);
        if (y !== void 0) {
          var x = bl, P = e;
          switch (e) {
            case "keypress":
              if (Or(n) === 0) break e;
            case "keydown":
            case "keyup":
              x = _c;
              break;
            case "focusin":
              P = "focus", x = nu;
              break;
            case "focusout":
              P = "blur", x = nu;
              break;
            case "beforeblur":
            case "afterblur":
              x = nu;
              break;
            case "click":
              if (n.button === 2) break e;
            case "auxclick":
            case "dblclick":
            case "mousedown":
            case "mousemove":
            case "mouseup":
            case "mouseout":
            case "mouseover":
            case "contextmenu":
              x = mo;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              x = cc;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              x = Cc;
              break;
            case Do:
            case Io:
            case Fo:
              x = pc;
              break;
            case Uo:
              x = Pc;
              break;
            case "scroll":
              x = sc;
              break;
            case "wheel":
              x = Tc;
              break;
            case "copy":
            case "cut":
            case "paste":
              x = mc;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              x = yo;
          }
          var z = (t & 4) !== 0, me = !z && e === "scroll", d = z ? y !== null ? y + "Capture" : null : y;
          z = [];
          for (var a = h, p; a !== null; ) {
            p = a;
            var S = p.stateNode;
            if (p.tag === 5 && S !== null && (p = S, d !== null && (S = In(a, d), S != null && z.push(tr(a, S, p)))), me) break;
            a = a.return;
          }
          0 < z.length && (y = new x(y, P, null, n, k), w.push({ event: y, listeners: z }));
        }
      }
      if ((t & 7) === 0) {
        e: {
          if (y = e === "mouseover" || e === "pointerover", x = e === "mouseout" || e === "pointerout", y && n !== Ul && (P = n.relatedTarget || n.fromElement) && (Gt(P) || P[gt])) break e;
          if ((x || y) && (y = k.window === k ? k : (y = k.ownerDocument) ? y.defaultView || y.parentWindow : window, x ? (P = n.relatedTarget || n.toElement, x = h, P = P ? Gt(P) : null, P !== null && (me = Xt(P), P !== me || P.tag !== 5 && P.tag !== 6) && (P = null)) : (x = null, P = h), x !== P)) {
            if (z = mo, S = "onMouseLeave", d = "onMouseEnter", a = "mouse", (e === "pointerout" || e === "pointerover") && (z = yo, S = "onPointerLeave", d = "onPointerEnter", a = "pointer"), me = x == null ? y : gn(x), p = P == null ? y : gn(P), y = new z(S, a + "leave", x, n, k), y.target = me, y.relatedTarget = p, S = null, Gt(k) === h && (z = new z(d, a + "enter", P, n, k), z.target = p, z.relatedTarget = me, S = z), me = S, x && P) t: {
              for (z = x, d = P, a = 0, p = z; p; p = vn(p)) a++;
              for (p = 0, S = d; S; S = vn(S)) p++;
              for (; 0 < a - p; ) z = vn(z), a--;
              for (; 0 < p - a; ) d = vn(d), p--;
              for (; a--; ) {
                if (z === d || d !== null && z === d.alternate) break t;
                z = vn(z), d = vn(d);
              }
              z = null;
            }
            else z = null;
            x !== null && Wo(w, y, x, z, !1), P !== null && me !== null && Wo(w, me, P, z, !0);
          }
        }
        e: {
          if (y = h ? gn(h) : window, x = y.nodeName && y.nodeName.toLowerCase(), x === "select" || x === "input" && y.type === "file") var R = Ic;
          else if (xo(y)) if (Co) R = Vc;
          else {
            R = Uc;
            var j = Fc;
          }
          else (x = y.nodeName) && x.toLowerCase() === "input" && (y.type === "checkbox" || y.type === "radio") && (R = Ac);
          if (R && (R = R(e, h))) {
            Eo(w, R, n, k);
            break e;
          }
          j && j(e, y, h), e === "focusout" && (j = y._wrapperState) && j.controlled && y.type === "number" && Ml(y, "number", y.value);
        }
        switch (j = h ? gn(h) : window, e) {
          case "focusin":
            (xo(j) || j.contentEditable === "true") && (hn = j, su = h, qn = null);
            break;
          case "focusout":
            qn = su = hn = null;
            break;
          case "mousedown":
            au = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            au = !1, Mo(w, n, k);
            break;
          case "selectionchange":
            if (Hc) break;
          case "keydown":
          case "keyup":
            Mo(w, n, k);
        }
        var M;
        if (lu) e: {
          switch (e) {
            case "compositionstart":
              var I = "onCompositionStart";
              break e;
            case "compositionend":
              I = "onCompositionEnd";
              break e;
            case "compositionupdate":
              I = "onCompositionUpdate";
              break e;
          }
          I = void 0;
        }
        else pn ? So(e, n) && (I = "onCompositionEnd") : e === "keydown" && n.keyCode === 229 && (I = "onCompositionStart");
        I && (go && n.locale !== "ko" && (pn || I !== "onCompositionStart" ? I === "onCompositionEnd" && pn && (M = po()) : (Lt = k, ql = "value" in Lt ? Lt.value : Lt.textContent, pn = !0)), j = $r(h, I), 0 < j.length && (I = new vo(I, e, null, n, k), w.push({ event: I, listeners: j }), M ? I.data = M : (M = _o(n), M !== null && (I.data = M)))), (M = Lc ? jc(e, n) : Mc(e, n)) && (h = $r(h, "onBeforeInput"), 0 < h.length && (k = new vo("onBeforeInput", "beforeinput", null, n, k), w.push({ event: k, listeners: h }), k.data = M));
      }
      Bo(w, t);
    });
  }
  function tr(e, t, n) {
    return { instance: e, listener: t, currentTarget: n };
  }
  function $r(e, t) {
    for (var n = t + "Capture", r = []; e !== null; ) {
      var l = e, u = l.stateNode;
      l.tag === 5 && u !== null && (l = u, u = In(e, n), u != null && r.unshift(tr(e, u, l)), u = In(e, t), u != null && r.push(tr(e, u, l))), e = e.return;
    }
    return r;
  }
  function vn(e) {
    if (e === null) return null;
    do
      e = e.return;
    while (e && e.tag !== 5);
    return e || null;
  }
  function Wo(e, t, n, r, l) {
    for (var u = t._reactName, i = []; n !== null && n !== r; ) {
      var o = n, s = o.alternate, h = o.stateNode;
      if (s !== null && s === r) break;
      o.tag === 5 && h !== null && (o = h, l ? (s = In(n, u), s != null && i.unshift(tr(n, s, o))) : l || (s = In(n, u), s != null && i.push(tr(n, s, o)))), n = n.return;
    }
    i.length !== 0 && e.push({ event: t, listeners: i });
  }
  var Yc = /\r\n?/g, Xc = /\u0000|\uFFFD/g;
  function Qo(e) {
    return (typeof e == "string" ? e : "" + e).replace(Yc, `
`).replace(Xc, "");
  }
  function Br(e, t, n) {
    if (t = Qo(t), Qo(e) !== t && n) throw Error(c(425));
  }
  function Hr() {
  }
  var mu = null, vu = null;
  function yu(e, t) {
    return e === "textarea" || e === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
  }
  var gu = typeof setTimeout == "function" ? setTimeout : void 0, Gc = typeof clearTimeout == "function" ? clearTimeout : void 0, Ko = typeof Promise == "function" ? Promise : void 0, Zc = typeof queueMicrotask == "function" ? queueMicrotask : typeof Ko < "u" ? function(e) {
    return Ko.resolve(null).then(e).catch(Jc);
  } : gu;
  function Jc(e) {
    setTimeout(function() {
      throw e;
    });
  }
  function ku(e, t) {
    var n = t, r = 0;
    do {
      var l = n.nextSibling;
      if (e.removeChild(n), l && l.nodeType === 8) if (n = l.data, n === "/$") {
        if (r === 0) {
          e.removeChild(l), Qn(t);
          return;
        }
        r--;
      } else n !== "$" && n !== "$?" && n !== "$!" || r++;
      n = l;
    } while (n);
    Qn(t);
  }
  function Mt(e) {
    for (; e != null; e = e.nextSibling) {
      var t = e.nodeType;
      if (t === 1 || t === 3) break;
      if (t === 8) {
        if (t = e.data, t === "$" || t === "$!" || t === "$?") break;
        if (t === "/$") return null;
      }
    }
    return e;
  }
  function Yo(e) {
    e = e.previousSibling;
    for (var t = 0; e; ) {
      if (e.nodeType === 8) {
        var n = e.data;
        if (n === "$" || n === "$!" || n === "$?") {
          if (t === 0) return e;
          t--;
        } else n === "/$" && t++;
      }
      e = e.previousSibling;
    }
    return null;
  }
  var yn = Math.random().toString(36).slice(2), pt = "__reactFiber$" + yn, nr = "__reactProps$" + yn, gt = "__reactContainer$" + yn, wu = "__reactEvents$" + yn, qc = "__reactListeners$" + yn, bc = "__reactHandles$" + yn;
  function Gt(e) {
    var t = e[pt];
    if (t) return t;
    for (var n = e.parentNode; n; ) {
      if (t = n[gt] || n[pt]) {
        if (n = t.alternate, t.child !== null || n !== null && n.child !== null) for (e = Yo(e); e !== null; ) {
          if (n = e[pt]) return n;
          e = Yo(e);
        }
        return t;
      }
      e = n, n = e.parentNode;
    }
    return null;
  }
  function rr(e) {
    return e = e[pt] || e[gt], !e || e.tag !== 5 && e.tag !== 6 && e.tag !== 13 && e.tag !== 3 ? null : e;
  }
  function gn(e) {
    if (e.tag === 5 || e.tag === 6) return e.stateNode;
    throw Error(c(33));
  }
  function Wr(e) {
    return e[nr] || null;
  }
  var Su = [], kn = -1;
  function Ot(e) {
    return { current: e };
  }
  function ue(e) {
    0 > kn || (e.current = Su[kn], Su[kn] = null, kn--);
  }
  function re(e, t) {
    kn++, Su[kn] = e.current, e.current = t;
  }
  var Dt = {}, ze = Ot(Dt), Fe = Ot(!1), Zt = Dt;
  function wn(e, t) {
    var n = e.type.contextTypes;
    if (!n) return Dt;
    var r = e.stateNode;
    if (r && r.__reactInternalMemoizedUnmaskedChildContext === t) return r.__reactInternalMemoizedMaskedChildContext;
    var l = {}, u;
    for (u in n) l[u] = t[u];
    return r && (e = e.stateNode, e.__reactInternalMemoizedUnmaskedChildContext = t, e.__reactInternalMemoizedMaskedChildContext = l), l;
  }
  function Ue(e) {
    return e = e.childContextTypes, e != null;
  }
  function Qr() {
    ue(Fe), ue(ze);
  }
  function Xo(e, t, n) {
    if (ze.current !== Dt) throw Error(c(168));
    re(ze, t), re(Fe, n);
  }
  function Go(e, t, n) {
    var r = e.stateNode;
    if (t = t.childContextTypes, typeof r.getChildContext != "function") return n;
    r = r.getChildContext();
    for (var l in r) if (!(l in t)) throw Error(c(108, ne(e) || "Unknown", l));
    return N({}, n, r);
  }
  function Kr(e) {
    return e = (e = e.stateNode) && e.__reactInternalMemoizedMergedChildContext || Dt, Zt = ze.current, re(ze, e), re(Fe, Fe.current), !0;
  }
  function Zo(e, t, n) {
    var r = e.stateNode;
    if (!r) throw Error(c(169));
    n ? (e = Go(e, t, Zt), r.__reactInternalMemoizedMergedChildContext = e, ue(Fe), ue(ze), re(ze, e)) : ue(Fe), re(Fe, n);
  }
  var kt = null, Yr = !1, _u = !1;
  function Jo(e) {
    kt === null ? kt = [e] : kt.push(e);
  }
  function ef(e) {
    Yr = !0, Jo(e);
  }
  function It() {
    if (!_u && kt !== null) {
      _u = !0;
      var e = 0, t = b;
      try {
        var n = kt;
        for (b = 1; e < n.length; e++) {
          var r = n[e];
          do
            r = r(!0);
          while (r !== null);
        }
        kt = null, Yr = !1;
      } catch (l) {
        throw kt !== null && (kt = kt.slice(e + 1)), qi(Wl, It), l;
      } finally {
        b = t, _u = !1;
      }
    }
    return null;
  }
  var Sn = [], _n = 0, Xr = null, Gr = 0, Ze = [], Je = 0, Jt = null, wt = 1, St = "";
  function qt(e, t) {
    Sn[_n++] = Gr, Sn[_n++] = Xr, Xr = e, Gr = t;
  }
  function qo(e, t, n) {
    Ze[Je++] = wt, Ze[Je++] = St, Ze[Je++] = Jt, Jt = e;
    var r = wt;
    e = St;
    var l = 32 - rt(r) - 1;
    r &= ~(1 << l), n += 1;
    var u = 32 - rt(t) + l;
    if (30 < u) {
      var i = l - l % 5;
      u = (r & (1 << i) - 1).toString(32), r >>= i, l -= i, wt = 1 << 32 - rt(t) + l | n << l | r, St = u + e;
    } else wt = 1 << u | n << l | r, St = e;
  }
  function xu(e) {
    e.return !== null && (qt(e, 1), qo(e, 1, 0));
  }
  function Eu(e) {
    for (; e === Xr; ) Xr = Sn[--_n], Sn[_n] = null, Gr = Sn[--_n], Sn[_n] = null;
    for (; e === Jt; ) Jt = Ze[--Je], Ze[Je] = null, St = Ze[--Je], Ze[Je] = null, wt = Ze[--Je], Ze[Je] = null;
  }
  var Ke = null, Ye = null, oe = !1, ut = null;
  function bo(e, t) {
    var n = tt(5, null, null, 0);
    n.elementType = "DELETED", n.stateNode = t, n.return = e, t = e.deletions, t === null ? (e.deletions = [n], e.flags |= 16) : t.push(n);
  }
  function es(e, t) {
    switch (e.tag) {
      case 5:
        var n = e.type;
        return t = t.nodeType !== 1 || n.toLowerCase() !== t.nodeName.toLowerCase() ? null : t, t !== null ? (e.stateNode = t, Ke = e, Ye = Mt(t.firstChild), !0) : !1;
      case 6:
        return t = e.pendingProps === "" || t.nodeType !== 3 ? null : t, t !== null ? (e.stateNode = t, Ke = e, Ye = null, !0) : !1;
      case 13:
        return t = t.nodeType !== 8 ? null : t, t !== null ? (n = Jt !== null ? { id: wt, overflow: St } : null, e.memoizedState = { dehydrated: t, treeContext: n, retryLane: 1073741824 }, n = tt(18, null, null, 0), n.stateNode = t, n.return = e, e.child = n, Ke = e, Ye = null, !0) : !1;
      default:
        return !1;
    }
  }
  function Cu(e) {
    return (e.mode & 1) !== 0 && (e.flags & 128) === 0;
  }
  function Nu(e) {
    if (oe) {
      var t = Ye;
      if (t) {
        var n = t;
        if (!es(e, t)) {
          if (Cu(e)) throw Error(c(418));
          t = Mt(n.nextSibling);
          var r = Ke;
          t && es(e, t) ? bo(r, n) : (e.flags = e.flags & -4097 | 2, oe = !1, Ke = e);
        }
      } else {
        if (Cu(e)) throw Error(c(418));
        e.flags = e.flags & -4097 | 2, oe = !1, Ke = e;
      }
    }
  }
  function ts(e) {
    for (e = e.return; e !== null && e.tag !== 5 && e.tag !== 3 && e.tag !== 13; ) e = e.return;
    Ke = e;
  }
  function Zr(e) {
    if (e !== Ke) return !1;
    if (!oe) return ts(e), oe = !0, !1;
    var t;
    if ((t = e.tag !== 3) && !(t = e.tag !== 5) && (t = e.type, t = t !== "head" && t !== "body" && !yu(e.type, e.memoizedProps)), t && (t = Ye)) {
      if (Cu(e)) throw ns(), Error(c(418));
      for (; t; ) bo(e, t), t = Mt(t.nextSibling);
    }
    if (ts(e), e.tag === 13) {
      if (e = e.memoizedState, e = e !== null ? e.dehydrated : null, !e) throw Error(c(317));
      e: {
        for (e = e.nextSibling, t = 0; e; ) {
          if (e.nodeType === 8) {
            var n = e.data;
            if (n === "/$") {
              if (t === 0) {
                Ye = Mt(e.nextSibling);
                break e;
              }
              t--;
            } else n !== "$" && n !== "$!" && n !== "$?" || t++;
          }
          e = e.nextSibling;
        }
        Ye = null;
      }
    } else Ye = Ke ? Mt(e.stateNode.nextSibling) : null;
    return !0;
  }
  function ns() {
    for (var e = Ye; e; ) e = Mt(e.nextSibling);
  }
  function xn() {
    Ye = Ke = null, oe = !1;
  }
  function Pu(e) {
    ut === null ? ut = [e] : ut.push(e);
  }
  var tf = ge.ReactCurrentBatchConfig;
  function lr(e, t, n) {
    if (e = n.ref, e !== null && typeof e != "function" && typeof e != "object") {
      if (n._owner) {
        if (n = n._owner, n) {
          if (n.tag !== 1) throw Error(c(309));
          var r = n.stateNode;
        }
        if (!r) throw Error(c(147, e));
        var l = r, u = "" + e;
        return t !== null && t.ref !== null && typeof t.ref == "function" && t.ref._stringRef === u ? t.ref : (t = function(i) {
          var o = l.refs;
          i === null ? delete o[u] : o[u] = i;
        }, t._stringRef = u, t);
      }
      if (typeof e != "string") throw Error(c(284));
      if (!n._owner) throw Error(c(290, e));
    }
    return e;
  }
  function Jr(e, t) {
    throw e = Object.prototype.toString.call(t), Error(c(31, e === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : e));
  }
  function rs(e) {
    var t = e._init;
    return t(e._payload);
  }
  function ls(e) {
    function t(d, a) {
      if (e) {
        var p = d.deletions;
        p === null ? (d.deletions = [a], d.flags |= 16) : p.push(a);
      }
    }
    function n(d, a) {
      if (!e) return null;
      for (; a !== null; ) t(d, a), a = a.sibling;
      return null;
    }
    function r(d, a) {
      for (d = /* @__PURE__ */ new Map(); a !== null; ) a.key !== null ? d.set(a.key, a) : d.set(a.index, a), a = a.sibling;
      return d;
    }
    function l(d, a) {
      return d = Wt(d, a), d.index = 0, d.sibling = null, d;
    }
    function u(d, a, p) {
      return d.index = p, e ? (p = d.alternate, p !== null ? (p = p.index, p < a ? (d.flags |= 2, a) : p) : (d.flags |= 2, a)) : (d.flags |= 1048576, a);
    }
    function i(d) {
      return e && d.alternate === null && (d.flags |= 2), d;
    }
    function o(d, a, p, S) {
      return a === null || a.tag !== 6 ? (a = gi(p, d.mode, S), a.return = d, a) : (a = l(a, p), a.return = d, a);
    }
    function s(d, a, p, S) {
      var R = p.type;
      return R === De ? k(d, a, p.props.children, S, p.key) : a !== null && (a.elementType === R || typeof R == "object" && R !== null && R.$$typeof === Ie && rs(R) === a.type) ? (S = l(a, p.props), S.ref = lr(d, a, p), S.return = d, S) : (S = Sl(p.type, p.key, p.props, null, d.mode, S), S.ref = lr(d, a, p), S.return = d, S);
    }
    function h(d, a, p, S) {
      return a === null || a.tag !== 4 || a.stateNode.containerInfo !== p.containerInfo || a.stateNode.implementation !== p.implementation ? (a = ki(p, d.mode, S), a.return = d, a) : (a = l(a, p.children || []), a.return = d, a);
    }
    function k(d, a, p, S, R) {
      return a === null || a.tag !== 7 ? (a = on(p, d.mode, S, R), a.return = d, a) : (a = l(a, p), a.return = d, a);
    }
    function w(d, a, p) {
      if (typeof a == "string" && a !== "" || typeof a == "number") return a = gi("" + a, d.mode, p), a.return = d, a;
      if (typeof a == "object" && a !== null) {
        switch (a.$$typeof) {
          case Pe:
            return p = Sl(a.type, a.key, a.props, null, d.mode, p), p.ref = lr(d, null, a), p.return = d, p;
          case je:
            return a = ki(a, d.mode, p), a.return = d, a;
          case Ie:
            var S = a._init;
            return w(d, S(a._payload), p);
        }
        if (Mn(a) || D(a)) return a = on(a, d.mode, p, null), a.return = d, a;
        Jr(d, a);
      }
      return null;
    }
    function y(d, a, p, S) {
      var R = a !== null ? a.key : null;
      if (typeof p == "string" && p !== "" || typeof p == "number") return R !== null ? null : o(d, a, "" + p, S);
      if (typeof p == "object" && p !== null) {
        switch (p.$$typeof) {
          case Pe:
            return p.key === R ? s(d, a, p, S) : null;
          case je:
            return p.key === R ? h(d, a, p, S) : null;
          case Ie:
            return R = p._init, y(
              d,
              a,
              R(p._payload),
              S
            );
        }
        if (Mn(p) || D(p)) return R !== null ? null : k(d, a, p, S, null);
        Jr(d, p);
      }
      return null;
    }
    function x(d, a, p, S, R) {
      if (typeof S == "string" && S !== "" || typeof S == "number") return d = d.get(p) || null, o(a, d, "" + S, R);
      if (typeof S == "object" && S !== null) {
        switch (S.$$typeof) {
          case Pe:
            return d = d.get(S.key === null ? p : S.key) || null, s(a, d, S, R);
          case je:
            return d = d.get(S.key === null ? p : S.key) || null, h(a, d, S, R);
          case Ie:
            var j = S._init;
            return x(d, a, p, j(S._payload), R);
        }
        if (Mn(S) || D(S)) return d = d.get(p) || null, k(a, d, S, R, null);
        Jr(a, S);
      }
      return null;
    }
    function P(d, a, p, S) {
      for (var R = null, j = null, M = a, I = a = 0, xe = null; M !== null && I < p.length; I++) {
        M.index > I ? (xe = M, M = null) : xe = M.sibling;
        var Z = y(d, M, p[I], S);
        if (Z === null) {
          M === null && (M = xe);
          break;
        }
        e && M && Z.alternate === null && t(d, M), a = u(Z, a, I), j === null ? R = Z : j.sibling = Z, j = Z, M = xe;
      }
      if (I === p.length) return n(d, M), oe && qt(d, I), R;
      if (M === null) {
        for (; I < p.length; I++) M = w(d, p[I], S), M !== null && (a = u(M, a, I), j === null ? R = M : j.sibling = M, j = M);
        return oe && qt(d, I), R;
      }
      for (M = r(d, M); I < p.length; I++) xe = x(M, d, I, p[I], S), xe !== null && (e && xe.alternate !== null && M.delete(xe.key === null ? I : xe.key), a = u(xe, a, I), j === null ? R = xe : j.sibling = xe, j = xe);
      return e && M.forEach(function(Qt) {
        return t(d, Qt);
      }), oe && qt(d, I), R;
    }
    function z(d, a, p, S) {
      var R = D(p);
      if (typeof R != "function") throw Error(c(150));
      if (p = R.call(p), p == null) throw Error(c(151));
      for (var j = R = null, M = a, I = a = 0, xe = null, Z = p.next(); M !== null && !Z.done; I++, Z = p.next()) {
        M.index > I ? (xe = M, M = null) : xe = M.sibling;
        var Qt = y(d, M, Z.value, S);
        if (Qt === null) {
          M === null && (M = xe);
          break;
        }
        e && M && Qt.alternate === null && t(d, M), a = u(Qt, a, I), j === null ? R = Qt : j.sibling = Qt, j = Qt, M = xe;
      }
      if (Z.done) return n(
        d,
        M
      ), oe && qt(d, I), R;
      if (M === null) {
        for (; !Z.done; I++, Z = p.next()) Z = w(d, Z.value, S), Z !== null && (a = u(Z, a, I), j === null ? R = Z : j.sibling = Z, j = Z);
        return oe && qt(d, I), R;
      }
      for (M = r(d, M); !Z.done; I++, Z = p.next()) Z = x(M, d, I, Z.value, S), Z !== null && (e && Z.alternate !== null && M.delete(Z.key === null ? I : Z.key), a = u(Z, a, I), j === null ? R = Z : j.sibling = Z, j = Z);
      return e && M.forEach(function(Df) {
        return t(d, Df);
      }), oe && qt(d, I), R;
    }
    function me(d, a, p, S) {
      if (typeof p == "object" && p !== null && p.type === De && p.key === null && (p = p.props.children), typeof p == "object" && p !== null) {
        switch (p.$$typeof) {
          case Pe:
            e: {
              for (var R = p.key, j = a; j !== null; ) {
                if (j.key === R) {
                  if (R = p.type, R === De) {
                    if (j.tag === 7) {
                      n(d, j.sibling), a = l(j, p.props.children), a.return = d, d = a;
                      break e;
                    }
                  } else if (j.elementType === R || typeof R == "object" && R !== null && R.$$typeof === Ie && rs(R) === j.type) {
                    n(d, j.sibling), a = l(j, p.props), a.ref = lr(d, j, p), a.return = d, d = a;
                    break e;
                  }
                  n(d, j);
                  break;
                } else t(d, j);
                j = j.sibling;
              }
              p.type === De ? (a = on(p.props.children, d.mode, S, p.key), a.return = d, d = a) : (S = Sl(p.type, p.key, p.props, null, d.mode, S), S.ref = lr(d, a, p), S.return = d, d = S);
            }
            return i(d);
          case je:
            e: {
              for (j = p.key; a !== null; ) {
                if (a.key === j) if (a.tag === 4 && a.stateNode.containerInfo === p.containerInfo && a.stateNode.implementation === p.implementation) {
                  n(d, a.sibling), a = l(a, p.children || []), a.return = d, d = a;
                  break e;
                } else {
                  n(d, a);
                  break;
                }
                else t(d, a);
                a = a.sibling;
              }
              a = ki(p, d.mode, S), a.return = d, d = a;
            }
            return i(d);
          case Ie:
            return j = p._init, me(d, a, j(p._payload), S);
        }
        if (Mn(p)) return P(d, a, p, S);
        if (D(p)) return z(d, a, p, S);
        Jr(d, p);
      }
      return typeof p == "string" && p !== "" || typeof p == "number" ? (p = "" + p, a !== null && a.tag === 6 ? (n(d, a.sibling), a = l(a, p), a.return = d, d = a) : (n(d, a), a = gi(p, d.mode, S), a.return = d, d = a), i(d)) : n(d, a);
    }
    return me;
  }
  var En = ls(!0), us = ls(!1), qr = Ot(null), br = null, Cn = null, zu = null;
  function Tu() {
    zu = Cn = br = null;
  }
  function Ru(e) {
    var t = qr.current;
    ue(qr), e._currentValue = t;
  }
  function Lu(e, t, n) {
    for (; e !== null; ) {
      var r = e.alternate;
      if ((e.childLanes & t) !== t ? (e.childLanes |= t, r !== null && (r.childLanes |= t)) : r !== null && (r.childLanes & t) !== t && (r.childLanes |= t), e === n) break;
      e = e.return;
    }
  }
  function Nn(e, t) {
    br = e, zu = Cn = null, e = e.dependencies, e !== null && e.firstContext !== null && ((e.lanes & t) !== 0 && (Ae = !0), e.firstContext = null);
  }
  function qe(e) {
    var t = e._currentValue;
    if (zu !== e) if (e = { context: e, memoizedValue: t, next: null }, Cn === null) {
      if (br === null) throw Error(c(308));
      Cn = e, br.dependencies = { lanes: 0, firstContext: e };
    } else Cn = Cn.next = e;
    return t;
  }
  var bt = null;
  function ju(e) {
    bt === null ? bt = [e] : bt.push(e);
  }
  function is(e, t, n, r) {
    var l = t.interleaved;
    return l === null ? (n.next = n, ju(t)) : (n.next = l.next, l.next = n), t.interleaved = n, _t(e, r);
  }
  function _t(e, t) {
    e.lanes |= t;
    var n = e.alternate;
    for (n !== null && (n.lanes |= t), n = e, e = e.return; e !== null; ) e.childLanes |= t, n = e.alternate, n !== null && (n.childLanes |= t), n = e, e = e.return;
    return n.tag === 3 ? n.stateNode : null;
  }
  var Ft = !1;
  function Mu(e) {
    e.updateQueue = { baseState: e.memoizedState, firstBaseUpdate: null, lastBaseUpdate: null, shared: { pending: null, interleaved: null, lanes: 0 }, effects: null };
  }
  function os(e, t) {
    e = e.updateQueue, t.updateQueue === e && (t.updateQueue = { baseState: e.baseState, firstBaseUpdate: e.firstBaseUpdate, lastBaseUpdate: e.lastBaseUpdate, shared: e.shared, effects: e.effects });
  }
  function xt(e, t) {
    return { eventTime: e, lane: t, tag: 0, payload: null, callback: null, next: null };
  }
  function Ut(e, t, n) {
    var r = e.updateQueue;
    if (r === null) return null;
    if (r = r.shared, (K & 2) !== 0) {
      var l = r.pending;
      return l === null ? t.next = t : (t.next = l.next, l.next = t), r.pending = t, _t(e, n);
    }
    return l = r.interleaved, l === null ? (t.next = t, ju(r)) : (t.next = l.next, l.next = t), r.interleaved = t, _t(e, n);
  }
  function el(e, t, n) {
    if (t = t.updateQueue, t !== null && (t = t.shared, (n & 4194240) !== 0)) {
      var r = t.lanes;
      r &= e.pendingLanes, n |= r, t.lanes = n, Yl(e, n);
    }
  }
  function ss(e, t) {
    var n = e.updateQueue, r = e.alternate;
    if (r !== null && (r = r.updateQueue, n === r)) {
      var l = null, u = null;
      if (n = n.firstBaseUpdate, n !== null) {
        do {
          var i = { eventTime: n.eventTime, lane: n.lane, tag: n.tag, payload: n.payload, callback: n.callback, next: null };
          u === null ? l = u = i : u = u.next = i, n = n.next;
        } while (n !== null);
        u === null ? l = u = t : u = u.next = t;
      } else l = u = t;
      n = { baseState: r.baseState, firstBaseUpdate: l, lastBaseUpdate: u, shared: r.shared, effects: r.effects }, e.updateQueue = n;
      return;
    }
    e = n.lastBaseUpdate, e === null ? n.firstBaseUpdate = t : e.next = t, n.lastBaseUpdate = t;
  }
  function tl(e, t, n, r) {
    var l = e.updateQueue;
    Ft = !1;
    var u = l.firstBaseUpdate, i = l.lastBaseUpdate, o = l.shared.pending;
    if (o !== null) {
      l.shared.pending = null;
      var s = o, h = s.next;
      s.next = null, i === null ? u = h : i.next = h, i = s;
      var k = e.alternate;
      k !== null && (k = k.updateQueue, o = k.lastBaseUpdate, o !== i && (o === null ? k.firstBaseUpdate = h : o.next = h, k.lastBaseUpdate = s));
    }
    if (u !== null) {
      var w = l.baseState;
      i = 0, k = h = s = null, o = u;
      do {
        var y = o.lane, x = o.eventTime;
        if ((r & y) === y) {
          k !== null && (k = k.next = {
            eventTime: x,
            lane: 0,
            tag: o.tag,
            payload: o.payload,
            callback: o.callback,
            next: null
          });
          e: {
            var P = e, z = o;
            switch (y = t, x = n, z.tag) {
              case 1:
                if (P = z.payload, typeof P == "function") {
                  w = P.call(x, w, y);
                  break e;
                }
                w = P;
                break e;
              case 3:
                P.flags = P.flags & -65537 | 128;
              case 0:
                if (P = z.payload, y = typeof P == "function" ? P.call(x, w, y) : P, y == null) break e;
                w = N({}, w, y);
                break e;
              case 2:
                Ft = !0;
            }
          }
          o.callback !== null && o.lane !== 0 && (e.flags |= 64, y = l.effects, y === null ? l.effects = [o] : y.push(o));
        } else x = { eventTime: x, lane: y, tag: o.tag, payload: o.payload, callback: o.callback, next: null }, k === null ? (h = k = x, s = w) : k = k.next = x, i |= y;
        if (o = o.next, o === null) {
          if (o = l.shared.pending, o === null) break;
          y = o, o = y.next, y.next = null, l.lastBaseUpdate = y, l.shared.pending = null;
        }
      } while (!0);
      if (k === null && (s = w), l.baseState = s, l.firstBaseUpdate = h, l.lastBaseUpdate = k, t = l.shared.interleaved, t !== null) {
        l = t;
        do
          i |= l.lane, l = l.next;
        while (l !== t);
      } else u === null && (l.shared.lanes = 0);
      nn |= i, e.lanes = i, e.memoizedState = w;
    }
  }
  function as(e, t, n) {
    if (e = t.effects, t.effects = null, e !== null) for (t = 0; t < e.length; t++) {
      var r = e[t], l = r.callback;
      if (l !== null) {
        if (r.callback = null, r = n, typeof l != "function") throw Error(c(191, l));
        l.call(r);
      }
    }
  }
  var ur = {}, ht = Ot(ur), ir = Ot(ur), or = Ot(ur);
  function en(e) {
    if (e === ur) throw Error(c(174));
    return e;
  }
  function Ou(e, t) {
    switch (re(or, t), re(ir, e), re(ht, ur), e = t.nodeType, e) {
      case 9:
      case 11:
        t = (t = t.documentElement) ? t.namespaceURI : Dl(null, "");
        break;
      default:
        e = e === 8 ? t.parentNode : t, t = e.namespaceURI || null, e = e.tagName, t = Dl(t, e);
    }
    ue(ht), re(ht, t);
  }
  function Pn() {
    ue(ht), ue(ir), ue(or);
  }
  function cs(e) {
    en(or.current);
    var t = en(ht.current), n = Dl(t, e.type);
    t !== n && (re(ir, e), re(ht, n));
  }
  function Du(e) {
    ir.current === e && (ue(ht), ue(ir));
  }
  var ae = Ot(0);
  function nl(e) {
    for (var t = e; t !== null; ) {
      if (t.tag === 13) {
        var n = t.memoizedState;
        if (n !== null && (n = n.dehydrated, n === null || n.data === "$?" || n.data === "$!")) return t;
      } else if (t.tag === 19 && t.memoizedProps.revealOrder !== void 0) {
        if ((t.flags & 128) !== 0) return t;
      } else if (t.child !== null) {
        t.child.return = t, t = t.child;
        continue;
      }
      if (t === e) break;
      for (; t.sibling === null; ) {
        if (t.return === null || t.return === e) return null;
        t = t.return;
      }
      t.sibling.return = t.return, t = t.sibling;
    }
    return null;
  }
  var Iu = [];
  function Fu() {
    for (var e = 0; e < Iu.length; e++) Iu[e]._workInProgressVersionPrimary = null;
    Iu.length = 0;
  }
  var rl = ge.ReactCurrentDispatcher, Uu = ge.ReactCurrentBatchConfig, tn = 0, ce = null, ke = null, Se = null, ll = !1, sr = !1, ar = 0, nf = 0;
  function Te() {
    throw Error(c(321));
  }
  function Au(e, t) {
    if (t === null) return !1;
    for (var n = 0; n < t.length && n < e.length; n++) if (!lt(e[n], t[n])) return !1;
    return !0;
  }
  function Vu(e, t, n, r, l, u) {
    if (tn = u, ce = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, rl.current = e === null || e.memoizedState === null ? of : sf, e = n(r, l), sr) {
      u = 0;
      do {
        if (sr = !1, ar = 0, 25 <= u) throw Error(c(301));
        u += 1, Se = ke = null, t.updateQueue = null, rl.current = af, e = n(r, l);
      } while (sr);
    }
    if (rl.current = ol, t = ke !== null && ke.next !== null, tn = 0, Se = ke = ce = null, ll = !1, t) throw Error(c(300));
    return e;
  }
  function $u() {
    var e = ar !== 0;
    return ar = 0, e;
  }
  function mt() {
    var e = { memoizedState: null, baseState: null, baseQueue: null, queue: null, next: null };
    return Se === null ? ce.memoizedState = Se = e : Se = Se.next = e, Se;
  }
  function be() {
    if (ke === null) {
      var e = ce.alternate;
      e = e !== null ? e.memoizedState : null;
    } else e = ke.next;
    var t = Se === null ? ce.memoizedState : Se.next;
    if (t !== null) Se = t, ke = e;
    else {
      if (e === null) throw Error(c(310));
      ke = e, e = { memoizedState: ke.memoizedState, baseState: ke.baseState, baseQueue: ke.baseQueue, queue: ke.queue, next: null }, Se === null ? ce.memoizedState = Se = e : Se = Se.next = e;
    }
    return Se;
  }
  function cr(e, t) {
    return typeof t == "function" ? t(e) : t;
  }
  function Bu(e) {
    var t = be(), n = t.queue;
    if (n === null) throw Error(c(311));
    n.lastRenderedReducer = e;
    var r = ke, l = r.baseQueue, u = n.pending;
    if (u !== null) {
      if (l !== null) {
        var i = l.next;
        l.next = u.next, u.next = i;
      }
      r.baseQueue = l = u, n.pending = null;
    }
    if (l !== null) {
      u = l.next, r = r.baseState;
      var o = i = null, s = null, h = u;
      do {
        var k = h.lane;
        if ((tn & k) === k) s !== null && (s = s.next = { lane: 0, action: h.action, hasEagerState: h.hasEagerState, eagerState: h.eagerState, next: null }), r = h.hasEagerState ? h.eagerState : e(r, h.action);
        else {
          var w = {
            lane: k,
            action: h.action,
            hasEagerState: h.hasEagerState,
            eagerState: h.eagerState,
            next: null
          };
          s === null ? (o = s = w, i = r) : s = s.next = w, ce.lanes |= k, nn |= k;
        }
        h = h.next;
      } while (h !== null && h !== u);
      s === null ? i = r : s.next = o, lt(r, t.memoizedState) || (Ae = !0), t.memoizedState = r, t.baseState = i, t.baseQueue = s, n.lastRenderedState = r;
    }
    if (e = n.interleaved, e !== null) {
      l = e;
      do
        u = l.lane, ce.lanes |= u, nn |= u, l = l.next;
      while (l !== e);
    } else l === null && (n.lanes = 0);
    return [t.memoizedState, n.dispatch];
  }
  function Hu(e) {
    var t = be(), n = t.queue;
    if (n === null) throw Error(c(311));
    n.lastRenderedReducer = e;
    var r = n.dispatch, l = n.pending, u = t.memoizedState;
    if (l !== null) {
      n.pending = null;
      var i = l = l.next;
      do
        u = e(u, i.action), i = i.next;
      while (i !== l);
      lt(u, t.memoizedState) || (Ae = !0), t.memoizedState = u, t.baseQueue === null && (t.baseState = u), n.lastRenderedState = u;
    }
    return [u, r];
  }
  function fs() {
  }
  function ds(e, t) {
    var n = ce, r = be(), l = t(), u = !lt(r.memoizedState, l);
    if (u && (r.memoizedState = l, Ae = !0), r = r.queue, Wu(ms.bind(null, n, r, e), [e]), r.getSnapshot !== t || u || Se !== null && Se.memoizedState.tag & 1) {
      if (n.flags |= 2048, fr(9, hs.bind(null, n, r, l, t), void 0, null), _e === null) throw Error(c(349));
      (tn & 30) !== 0 || ps(n, t, l);
    }
    return l;
  }
  function ps(e, t, n) {
    e.flags |= 16384, e = { getSnapshot: t, value: n }, t = ce.updateQueue, t === null ? (t = { lastEffect: null, stores: null }, ce.updateQueue = t, t.stores = [e]) : (n = t.stores, n === null ? t.stores = [e] : n.push(e));
  }
  function hs(e, t, n, r) {
    t.value = n, t.getSnapshot = r, vs(t) && ys(e);
  }
  function ms(e, t, n) {
    return n(function() {
      vs(t) && ys(e);
    });
  }
  function vs(e) {
    var t = e.getSnapshot;
    e = e.value;
    try {
      var n = t();
      return !lt(e, n);
    } catch {
      return !0;
    }
  }
  function ys(e) {
    var t = _t(e, 1);
    t !== null && at(t, e, 1, -1);
  }
  function gs(e) {
    var t = mt();
    return typeof e == "function" && (e = e()), t.memoizedState = t.baseState = e, e = { pending: null, interleaved: null, lanes: 0, dispatch: null, lastRenderedReducer: cr, lastRenderedState: e }, t.queue = e, e = e.dispatch = uf.bind(null, ce, e), [t.memoizedState, e];
  }
  function fr(e, t, n, r) {
    return e = { tag: e, create: t, destroy: n, deps: r, next: null }, t = ce.updateQueue, t === null ? (t = { lastEffect: null, stores: null }, ce.updateQueue = t, t.lastEffect = e.next = e) : (n = t.lastEffect, n === null ? t.lastEffect = e.next = e : (r = n.next, n.next = e, e.next = r, t.lastEffect = e)), e;
  }
  function ks() {
    return be().memoizedState;
  }
  function ul(e, t, n, r) {
    var l = mt();
    ce.flags |= e, l.memoizedState = fr(1 | t, n, void 0, r === void 0 ? null : r);
  }
  function il(e, t, n, r) {
    var l = be();
    r = r === void 0 ? null : r;
    var u = void 0;
    if (ke !== null) {
      var i = ke.memoizedState;
      if (u = i.destroy, r !== null && Au(r, i.deps)) {
        l.memoizedState = fr(t, n, u, r);
        return;
      }
    }
    ce.flags |= e, l.memoizedState = fr(1 | t, n, u, r);
  }
  function ws(e, t) {
    return ul(8390656, 8, e, t);
  }
  function Wu(e, t) {
    return il(2048, 8, e, t);
  }
  function Ss(e, t) {
    return il(4, 2, e, t);
  }
  function _s(e, t) {
    return il(4, 4, e, t);
  }
  function xs(e, t) {
    if (typeof t == "function") return e = e(), t(e), function() {
      t(null);
    };
    if (t != null) return e = e(), t.current = e, function() {
      t.current = null;
    };
  }
  function Es(e, t, n) {
    return n = n != null ? n.concat([e]) : null, il(4, 4, xs.bind(null, t, e), n);
  }
  function Qu() {
  }
  function Cs(e, t) {
    var n = be();
    t = t === void 0 ? null : t;
    var r = n.memoizedState;
    return r !== null && t !== null && Au(t, r[1]) ? r[0] : (n.memoizedState = [e, t], e);
  }
  function Ns(e, t) {
    var n = be();
    t = t === void 0 ? null : t;
    var r = n.memoizedState;
    return r !== null && t !== null && Au(t, r[1]) ? r[0] : (e = e(), n.memoizedState = [e, t], e);
  }
  function Ps(e, t, n) {
    return (tn & 21) === 0 ? (e.baseState && (e.baseState = !1, Ae = !0), e.memoizedState = n) : (lt(n, t) || (n = no(), ce.lanes |= n, nn |= n, e.baseState = !0), t);
  }
  function rf(e, t) {
    var n = b;
    b = n !== 0 && 4 > n ? n : 4, e(!0);
    var r = Uu.transition;
    Uu.transition = {};
    try {
      e(!1), t();
    } finally {
      b = n, Uu.transition = r;
    }
  }
  function zs() {
    return be().memoizedState;
  }
  function lf(e, t, n) {
    var r = Bt(e);
    if (n = { lane: r, action: n, hasEagerState: !1, eagerState: null, next: null }, Ts(e)) Rs(t, n);
    else if (n = is(e, t, n, r), n !== null) {
      var l = Oe();
      at(n, e, r, l), Ls(n, t, r);
    }
  }
  function uf(e, t, n) {
    var r = Bt(e), l = { lane: r, action: n, hasEagerState: !1, eagerState: null, next: null };
    if (Ts(e)) Rs(t, l);
    else {
      var u = e.alternate;
      if (e.lanes === 0 && (u === null || u.lanes === 0) && (u = t.lastRenderedReducer, u !== null)) try {
        var i = t.lastRenderedState, o = u(i, n);
        if (l.hasEagerState = !0, l.eagerState = o, lt(o, i)) {
          var s = t.interleaved;
          s === null ? (l.next = l, ju(t)) : (l.next = s.next, s.next = l), t.interleaved = l;
          return;
        }
      } catch {
      } finally {
      }
      n = is(e, t, l, r), n !== null && (l = Oe(), at(n, e, r, l), Ls(n, t, r));
    }
  }
  function Ts(e) {
    var t = e.alternate;
    return e === ce || t !== null && t === ce;
  }
  function Rs(e, t) {
    sr = ll = !0;
    var n = e.pending;
    n === null ? t.next = t : (t.next = n.next, n.next = t), e.pending = t;
  }
  function Ls(e, t, n) {
    if ((n & 4194240) !== 0) {
      var r = t.lanes;
      r &= e.pendingLanes, n |= r, t.lanes = n, Yl(e, n);
    }
  }
  var ol = { readContext: qe, useCallback: Te, useContext: Te, useEffect: Te, useImperativeHandle: Te, useInsertionEffect: Te, useLayoutEffect: Te, useMemo: Te, useReducer: Te, useRef: Te, useState: Te, useDebugValue: Te, useDeferredValue: Te, useTransition: Te, useMutableSource: Te, useSyncExternalStore: Te, useId: Te, unstable_isNewReconciler: !1 }, of = { readContext: qe, useCallback: function(e, t) {
    return mt().memoizedState = [e, t === void 0 ? null : t], e;
  }, useContext: qe, useEffect: ws, useImperativeHandle: function(e, t, n) {
    return n = n != null ? n.concat([e]) : null, ul(
      4194308,
      4,
      xs.bind(null, t, e),
      n
    );
  }, useLayoutEffect: function(e, t) {
    return ul(4194308, 4, e, t);
  }, useInsertionEffect: function(e, t) {
    return ul(4, 2, e, t);
  }, useMemo: function(e, t) {
    var n = mt();
    return t = t === void 0 ? null : t, e = e(), n.memoizedState = [e, t], e;
  }, useReducer: function(e, t, n) {
    var r = mt();
    return t = n !== void 0 ? n(t) : t, r.memoizedState = r.baseState = t, e = { pending: null, interleaved: null, lanes: 0, dispatch: null, lastRenderedReducer: e, lastRenderedState: t }, r.queue = e, e = e.dispatch = lf.bind(null, ce, e), [r.memoizedState, e];
  }, useRef: function(e) {
    var t = mt();
    return e = { current: e }, t.memoizedState = e;
  }, useState: gs, useDebugValue: Qu, useDeferredValue: function(e) {
    return mt().memoizedState = e;
  }, useTransition: function() {
    var e = gs(!1), t = e[0];
    return e = rf.bind(null, e[1]), mt().memoizedState = e, [t, e];
  }, useMutableSource: function() {
  }, useSyncExternalStore: function(e, t, n) {
    var r = ce, l = mt();
    if (oe) {
      if (n === void 0) throw Error(c(407));
      n = n();
    } else {
      if (n = t(), _e === null) throw Error(c(349));
      (tn & 30) !== 0 || ps(r, t, n);
    }
    l.memoizedState = n;
    var u = { value: n, getSnapshot: t };
    return l.queue = u, ws(ms.bind(
      null,
      r,
      u,
      e
    ), [e]), r.flags |= 2048, fr(9, hs.bind(null, r, u, n, t), void 0, null), n;
  }, useId: function() {
    var e = mt(), t = _e.identifierPrefix;
    if (oe) {
      var n = St, r = wt;
      n = (r & ~(1 << 32 - rt(r) - 1)).toString(32) + n, t = ":" + t + "R" + n, n = ar++, 0 < n && (t += "H" + n.toString(32)), t += ":";
    } else n = nf++, t = ":" + t + "r" + n.toString(32) + ":";
    return e.memoizedState = t;
  }, unstable_isNewReconciler: !1 }, sf = {
    readContext: qe,
    useCallback: Cs,
    useContext: qe,
    useEffect: Wu,
    useImperativeHandle: Es,
    useInsertionEffect: Ss,
    useLayoutEffect: _s,
    useMemo: Ns,
    useReducer: Bu,
    useRef: ks,
    useState: function() {
      return Bu(cr);
    },
    useDebugValue: Qu,
    useDeferredValue: function(e) {
      var t = be();
      return Ps(t, ke.memoizedState, e);
    },
    useTransition: function() {
      var e = Bu(cr)[0], t = be().memoizedState;
      return [e, t];
    },
    useMutableSource: fs,
    useSyncExternalStore: ds,
    useId: zs,
    unstable_isNewReconciler: !1
  }, af = { readContext: qe, useCallback: Cs, useContext: qe, useEffect: Wu, useImperativeHandle: Es, useInsertionEffect: Ss, useLayoutEffect: _s, useMemo: Ns, useReducer: Hu, useRef: ks, useState: function() {
    return Hu(cr);
  }, useDebugValue: Qu, useDeferredValue: function(e) {
    var t = be();
    return ke === null ? t.memoizedState = e : Ps(t, ke.memoizedState, e);
  }, useTransition: function() {
    var e = Hu(cr)[0], t = be().memoizedState;
    return [e, t];
  }, useMutableSource: fs, useSyncExternalStore: ds, useId: zs, unstable_isNewReconciler: !1 };
  function it(e, t) {
    if (e && e.defaultProps) {
      t = N({}, t), e = e.defaultProps;
      for (var n in e) t[n] === void 0 && (t[n] = e[n]);
      return t;
    }
    return t;
  }
  function Ku(e, t, n, r) {
    t = e.memoizedState, n = n(r, t), n = n == null ? t : N({}, t, n), e.memoizedState = n, e.lanes === 0 && (e.updateQueue.baseState = n);
  }
  var sl = { isMounted: function(e) {
    return (e = e._reactInternals) ? Xt(e) === e : !1;
  }, enqueueSetState: function(e, t, n) {
    e = e._reactInternals;
    var r = Oe(), l = Bt(e), u = xt(r, l);
    u.payload = t, n != null && (u.callback = n), t = Ut(e, u, l), t !== null && (at(t, e, l, r), el(t, e, l));
  }, enqueueReplaceState: function(e, t, n) {
    e = e._reactInternals;
    var r = Oe(), l = Bt(e), u = xt(r, l);
    u.tag = 1, u.payload = t, n != null && (u.callback = n), t = Ut(e, u, l), t !== null && (at(t, e, l, r), el(t, e, l));
  }, enqueueForceUpdate: function(e, t) {
    e = e._reactInternals;
    var n = Oe(), r = Bt(e), l = xt(n, r);
    l.tag = 2, t != null && (l.callback = t), t = Ut(e, l, r), t !== null && (at(t, e, r, n), el(t, e, r));
  } };
  function js(e, t, n, r, l, u, i) {
    return e = e.stateNode, typeof e.shouldComponentUpdate == "function" ? e.shouldComponentUpdate(r, u, i) : t.prototype && t.prototype.isPureReactComponent ? !Jn(n, r) || !Jn(l, u) : !0;
  }
  function Ms(e, t, n) {
    var r = !1, l = Dt, u = t.contextType;
    return typeof u == "object" && u !== null ? u = qe(u) : (l = Ue(t) ? Zt : ze.current, r = t.contextTypes, u = (r = r != null) ? wn(e, l) : Dt), t = new t(n, u), e.memoizedState = t.state !== null && t.state !== void 0 ? t.state : null, t.updater = sl, e.stateNode = t, t._reactInternals = e, r && (e = e.stateNode, e.__reactInternalMemoizedUnmaskedChildContext = l, e.__reactInternalMemoizedMaskedChildContext = u), t;
  }
  function Os(e, t, n, r) {
    e = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(n, r), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(n, r), t.state !== e && sl.enqueueReplaceState(t, t.state, null);
  }
  function Yu(e, t, n, r) {
    var l = e.stateNode;
    l.props = n, l.state = e.memoizedState, l.refs = {}, Mu(e);
    var u = t.contextType;
    typeof u == "object" && u !== null ? l.context = qe(u) : (u = Ue(t) ? Zt : ze.current, l.context = wn(e, u)), l.state = e.memoizedState, u = t.getDerivedStateFromProps, typeof u == "function" && (Ku(e, t, u, n), l.state = e.memoizedState), typeof t.getDerivedStateFromProps == "function" || typeof l.getSnapshotBeforeUpdate == "function" || typeof l.UNSAFE_componentWillMount != "function" && typeof l.componentWillMount != "function" || (t = l.state, typeof l.componentWillMount == "function" && l.componentWillMount(), typeof l.UNSAFE_componentWillMount == "function" && l.UNSAFE_componentWillMount(), t !== l.state && sl.enqueueReplaceState(l, l.state, null), tl(e, n, l, r), l.state = e.memoizedState), typeof l.componentDidMount == "function" && (e.flags |= 4194308);
  }
  function zn(e, t) {
    try {
      var n = "", r = t;
      do
        n += X(r), r = r.return;
      while (r);
      var l = n;
    } catch (u) {
      l = `
Error generating stack: ` + u.message + `
` + u.stack;
    }
    return { value: e, source: t, stack: l, digest: null };
  }
  function Xu(e, t, n) {
    return { value: e, source: null, stack: n ?? null, digest: t ?? null };
  }
  function Gu(e, t) {
    try {
      console.error(t.value);
    } catch (n) {
      setTimeout(function() {
        throw n;
      });
    }
  }
  var cf = typeof WeakMap == "function" ? WeakMap : Map;
  function Ds(e, t, n) {
    n = xt(-1, n), n.tag = 3, n.payload = { element: null };
    var r = t.value;
    return n.callback = function() {
      ml || (ml = !0, ci = r), Gu(e, t);
    }, n;
  }
  function Is(e, t, n) {
    n = xt(-1, n), n.tag = 3;
    var r = e.type.getDerivedStateFromError;
    if (typeof r == "function") {
      var l = t.value;
      n.payload = function() {
        return r(l);
      }, n.callback = function() {
        Gu(e, t);
      };
    }
    var u = e.stateNode;
    return u !== null && typeof u.componentDidCatch == "function" && (n.callback = function() {
      Gu(e, t), typeof r != "function" && (Vt === null ? Vt = /* @__PURE__ */ new Set([this]) : Vt.add(this));
      var i = t.stack;
      this.componentDidCatch(t.value, { componentStack: i !== null ? i : "" });
    }), n;
  }
  function Fs(e, t, n) {
    var r = e.pingCache;
    if (r === null) {
      r = e.pingCache = new cf();
      var l = /* @__PURE__ */ new Set();
      r.set(t, l);
    } else l = r.get(t), l === void 0 && (l = /* @__PURE__ */ new Set(), r.set(t, l));
    l.has(n) || (l.add(n), e = Ef.bind(null, e, t, n), t.then(e, e));
  }
  function Us(e) {
    do {
      var t;
      if ((t = e.tag === 13) && (t = e.memoizedState, t = t !== null ? t.dehydrated !== null : !0), t) return e;
      e = e.return;
    } while (e !== null);
    return null;
  }
  function As(e, t, n, r, l) {
    return (e.mode & 1) === 0 ? (e === t ? e.flags |= 65536 : (e.flags |= 128, n.flags |= 131072, n.flags &= -52805, n.tag === 1 && (n.alternate === null ? n.tag = 17 : (t = xt(-1, 1), t.tag = 2, Ut(n, t, 1))), n.lanes |= 1), e) : (e.flags |= 65536, e.lanes = l, e);
  }
  var ff = ge.ReactCurrentOwner, Ae = !1;
  function Me(e, t, n, r) {
    t.child = e === null ? us(t, null, n, r) : En(t, e.child, n, r);
  }
  function Vs(e, t, n, r, l) {
    n = n.render;
    var u = t.ref;
    return Nn(t, l), r = Vu(e, t, n, r, u, l), n = $u(), e !== null && !Ae ? (t.updateQueue = e.updateQueue, t.flags &= -2053, e.lanes &= ~l, Et(e, t, l)) : (oe && n && xu(t), t.flags |= 1, Me(e, t, r, l), t.child);
  }
  function $s(e, t, n, r, l) {
    if (e === null) {
      var u = n.type;
      return typeof u == "function" && !yi(u) && u.defaultProps === void 0 && n.compare === null && n.defaultProps === void 0 ? (t.tag = 15, t.type = u, Bs(e, t, u, r, l)) : (e = Sl(n.type, null, r, t, t.mode, l), e.ref = t.ref, e.return = t, t.child = e);
    }
    if (u = e.child, (e.lanes & l) === 0) {
      var i = u.memoizedProps;
      if (n = n.compare, n = n !== null ? n : Jn, n(i, r) && e.ref === t.ref) return Et(e, t, l);
    }
    return t.flags |= 1, e = Wt(u, r), e.ref = t.ref, e.return = t, t.child = e;
  }
  function Bs(e, t, n, r, l) {
    if (e !== null) {
      var u = e.memoizedProps;
      if (Jn(u, r) && e.ref === t.ref) if (Ae = !1, t.pendingProps = r = u, (e.lanes & l) !== 0) (e.flags & 131072) !== 0 && (Ae = !0);
      else return t.lanes = e.lanes, Et(e, t, l);
    }
    return Zu(e, t, n, r, l);
  }
  function Hs(e, t, n) {
    var r = t.pendingProps, l = r.children, u = e !== null ? e.memoizedState : null;
    if (r.mode === "hidden") if ((t.mode & 1) === 0) t.memoizedState = { baseLanes: 0, cachePool: null, transitions: null }, re(Rn, Xe), Xe |= n;
    else {
      if ((n & 1073741824) === 0) return e = u !== null ? u.baseLanes | n : n, t.lanes = t.childLanes = 1073741824, t.memoizedState = { baseLanes: e, cachePool: null, transitions: null }, t.updateQueue = null, re(Rn, Xe), Xe |= e, null;
      t.memoizedState = { baseLanes: 0, cachePool: null, transitions: null }, r = u !== null ? u.baseLanes : n, re(Rn, Xe), Xe |= r;
    }
    else u !== null ? (r = u.baseLanes | n, t.memoizedState = null) : r = n, re(Rn, Xe), Xe |= r;
    return Me(e, t, l, n), t.child;
  }
  function Ws(e, t) {
    var n = t.ref;
    (e === null && n !== null || e !== null && e.ref !== n) && (t.flags |= 512, t.flags |= 2097152);
  }
  function Zu(e, t, n, r, l) {
    var u = Ue(n) ? Zt : ze.current;
    return u = wn(t, u), Nn(t, l), n = Vu(e, t, n, r, u, l), r = $u(), e !== null && !Ae ? (t.updateQueue = e.updateQueue, t.flags &= -2053, e.lanes &= ~l, Et(e, t, l)) : (oe && r && xu(t), t.flags |= 1, Me(e, t, n, l), t.child);
  }
  function Qs(e, t, n, r, l) {
    if (Ue(n)) {
      var u = !0;
      Kr(t);
    } else u = !1;
    if (Nn(t, l), t.stateNode === null) cl(e, t), Ms(t, n, r), Yu(t, n, r, l), r = !0;
    else if (e === null) {
      var i = t.stateNode, o = t.memoizedProps;
      i.props = o;
      var s = i.context, h = n.contextType;
      typeof h == "object" && h !== null ? h = qe(h) : (h = Ue(n) ? Zt : ze.current, h = wn(t, h));
      var k = n.getDerivedStateFromProps, w = typeof k == "function" || typeof i.getSnapshotBeforeUpdate == "function";
      w || typeof i.UNSAFE_componentWillReceiveProps != "function" && typeof i.componentWillReceiveProps != "function" || (o !== r || s !== h) && Os(t, i, r, h), Ft = !1;
      var y = t.memoizedState;
      i.state = y, tl(t, r, i, l), s = t.memoizedState, o !== r || y !== s || Fe.current || Ft ? (typeof k == "function" && (Ku(t, n, k, r), s = t.memoizedState), (o = Ft || js(t, n, o, r, y, s, h)) ? (w || typeof i.UNSAFE_componentWillMount != "function" && typeof i.componentWillMount != "function" || (typeof i.componentWillMount == "function" && i.componentWillMount(), typeof i.UNSAFE_componentWillMount == "function" && i.UNSAFE_componentWillMount()), typeof i.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof i.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = r, t.memoizedState = s), i.props = r, i.state = s, i.context = h, r = o) : (typeof i.componentDidMount == "function" && (t.flags |= 4194308), r = !1);
    } else {
      i = t.stateNode, os(e, t), o = t.memoizedProps, h = t.type === t.elementType ? o : it(t.type, o), i.props = h, w = t.pendingProps, y = i.context, s = n.contextType, typeof s == "object" && s !== null ? s = qe(s) : (s = Ue(n) ? Zt : ze.current, s = wn(t, s));
      var x = n.getDerivedStateFromProps;
      (k = typeof x == "function" || typeof i.getSnapshotBeforeUpdate == "function") || typeof i.UNSAFE_componentWillReceiveProps != "function" && typeof i.componentWillReceiveProps != "function" || (o !== w || y !== s) && Os(t, i, r, s), Ft = !1, y = t.memoizedState, i.state = y, tl(t, r, i, l);
      var P = t.memoizedState;
      o !== w || y !== P || Fe.current || Ft ? (typeof x == "function" && (Ku(t, n, x, r), P = t.memoizedState), (h = Ft || js(t, n, h, r, y, P, s) || !1) ? (k || typeof i.UNSAFE_componentWillUpdate != "function" && typeof i.componentWillUpdate != "function" || (typeof i.componentWillUpdate == "function" && i.componentWillUpdate(r, P, s), typeof i.UNSAFE_componentWillUpdate == "function" && i.UNSAFE_componentWillUpdate(r, P, s)), typeof i.componentDidUpdate == "function" && (t.flags |= 4), typeof i.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof i.componentDidUpdate != "function" || o === e.memoizedProps && y === e.memoizedState || (t.flags |= 4), typeof i.getSnapshotBeforeUpdate != "function" || o === e.memoizedProps && y === e.memoizedState || (t.flags |= 1024), t.memoizedProps = r, t.memoizedState = P), i.props = r, i.state = P, i.context = s, r = h) : (typeof i.componentDidUpdate != "function" || o === e.memoizedProps && y === e.memoizedState || (t.flags |= 4), typeof i.getSnapshotBeforeUpdate != "function" || o === e.memoizedProps && y === e.memoizedState || (t.flags |= 1024), r = !1);
    }
    return Ju(e, t, n, r, u, l);
  }
  function Ju(e, t, n, r, l, u) {
    Ws(e, t);
    var i = (t.flags & 128) !== 0;
    if (!r && !i) return l && Zo(t, n, !1), Et(e, t, u);
    r = t.stateNode, ff.current = t;
    var o = i && typeof n.getDerivedStateFromError != "function" ? null : r.render();
    return t.flags |= 1, e !== null && i ? (t.child = En(t, e.child, null, u), t.child = En(t, null, o, u)) : Me(e, t, o, u), t.memoizedState = r.state, l && Zo(t, n, !0), t.child;
  }
  function Ks(e) {
    var t = e.stateNode;
    t.pendingContext ? Xo(e, t.pendingContext, t.pendingContext !== t.context) : t.context && Xo(e, t.context, !1), Ou(e, t.containerInfo);
  }
  function Ys(e, t, n, r, l) {
    return xn(), Pu(l), t.flags |= 256, Me(e, t, n, r), t.child;
  }
  var qu = { dehydrated: null, treeContext: null, retryLane: 0 };
  function bu(e) {
    return { baseLanes: e, cachePool: null, transitions: null };
  }
  function Xs(e, t, n) {
    var r = t.pendingProps, l = ae.current, u = !1, i = (t.flags & 128) !== 0, o;
    if ((o = i) || (o = e !== null && e.memoizedState === null ? !1 : (l & 2) !== 0), o ? (u = !0, t.flags &= -129) : (e === null || e.memoizedState !== null) && (l |= 1), re(ae, l & 1), e === null)
      return Nu(t), e = t.memoizedState, e !== null && (e = e.dehydrated, e !== null) ? ((t.mode & 1) === 0 ? t.lanes = 1 : e.data === "$!" ? t.lanes = 8 : t.lanes = 1073741824, null) : (i = r.children, e = r.fallback, u ? (r = t.mode, u = t.child, i = { mode: "hidden", children: i }, (r & 1) === 0 && u !== null ? (u.childLanes = 0, u.pendingProps = i) : u = _l(i, r, 0, null), e = on(e, r, n, null), u.return = t, e.return = t, u.sibling = e, t.child = u, t.child.memoizedState = bu(n), t.memoizedState = qu, e) : ei(t, i));
    if (l = e.memoizedState, l !== null && (o = l.dehydrated, o !== null)) return df(e, t, i, r, o, l, n);
    if (u) {
      u = r.fallback, i = t.mode, l = e.child, o = l.sibling;
      var s = { mode: "hidden", children: r.children };
      return (i & 1) === 0 && t.child !== l ? (r = t.child, r.childLanes = 0, r.pendingProps = s, t.deletions = null) : (r = Wt(l, s), r.subtreeFlags = l.subtreeFlags & 14680064), o !== null ? u = Wt(o, u) : (u = on(u, i, n, null), u.flags |= 2), u.return = t, r.return = t, r.sibling = u, t.child = r, r = u, u = t.child, i = e.child.memoizedState, i = i === null ? bu(n) : { baseLanes: i.baseLanes | n, cachePool: null, transitions: i.transitions }, u.memoizedState = i, u.childLanes = e.childLanes & ~n, t.memoizedState = qu, r;
    }
    return u = e.child, e = u.sibling, r = Wt(u, { mode: "visible", children: r.children }), (t.mode & 1) === 0 && (r.lanes = n), r.return = t, r.sibling = null, e !== null && (n = t.deletions, n === null ? (t.deletions = [e], t.flags |= 16) : n.push(e)), t.child = r, t.memoizedState = null, r;
  }
  function ei(e, t) {
    return t = _l({ mode: "visible", children: t }, e.mode, 0, null), t.return = e, e.child = t;
  }
  function al(e, t, n, r) {
    return r !== null && Pu(r), En(t, e.child, null, n), e = ei(t, t.pendingProps.children), e.flags |= 2, t.memoizedState = null, e;
  }
  function df(e, t, n, r, l, u, i) {
    if (n)
      return t.flags & 256 ? (t.flags &= -257, r = Xu(Error(c(422))), al(e, t, i, r)) : t.memoizedState !== null ? (t.child = e.child, t.flags |= 128, null) : (u = r.fallback, l = t.mode, r = _l({ mode: "visible", children: r.children }, l, 0, null), u = on(u, l, i, null), u.flags |= 2, r.return = t, u.return = t, r.sibling = u, t.child = r, (t.mode & 1) !== 0 && En(t, e.child, null, i), t.child.memoizedState = bu(i), t.memoizedState = qu, u);
    if ((t.mode & 1) === 0) return al(e, t, i, null);
    if (l.data === "$!") {
      if (r = l.nextSibling && l.nextSibling.dataset, r) var o = r.dgst;
      return r = o, u = Error(c(419)), r = Xu(u, r, void 0), al(e, t, i, r);
    }
    if (o = (i & e.childLanes) !== 0, Ae || o) {
      if (r = _e, r !== null) {
        switch (i & -i) {
          case 4:
            l = 2;
            break;
          case 16:
            l = 8;
            break;
          case 64:
          case 128:
          case 256:
          case 512:
          case 1024:
          case 2048:
          case 4096:
          case 8192:
          case 16384:
          case 32768:
          case 65536:
          case 131072:
          case 262144:
          case 524288:
          case 1048576:
          case 2097152:
          case 4194304:
          case 8388608:
          case 16777216:
          case 33554432:
          case 67108864:
            l = 32;
            break;
          case 536870912:
            l = 268435456;
            break;
          default:
            l = 0;
        }
        l = (l & (r.suspendedLanes | i)) !== 0 ? 0 : l, l !== 0 && l !== u.retryLane && (u.retryLane = l, _t(e, l), at(r, e, l, -1));
      }
      return vi(), r = Xu(Error(c(421))), al(e, t, i, r);
    }
    return l.data === "$?" ? (t.flags |= 128, t.child = e.child, t = Cf.bind(null, e), l._reactRetry = t, null) : (e = u.treeContext, Ye = Mt(l.nextSibling), Ke = t, oe = !0, ut = null, e !== null && (Ze[Je++] = wt, Ze[Je++] = St, Ze[Je++] = Jt, wt = e.id, St = e.overflow, Jt = t), t = ei(t, r.children), t.flags |= 4096, t);
  }
  function Gs(e, t, n) {
    e.lanes |= t;
    var r = e.alternate;
    r !== null && (r.lanes |= t), Lu(e.return, t, n);
  }
  function ti(e, t, n, r, l) {
    var u = e.memoizedState;
    u === null ? e.memoizedState = { isBackwards: t, rendering: null, renderingStartTime: 0, last: r, tail: n, tailMode: l } : (u.isBackwards = t, u.rendering = null, u.renderingStartTime = 0, u.last = r, u.tail = n, u.tailMode = l);
  }
  function Zs(e, t, n) {
    var r = t.pendingProps, l = r.revealOrder, u = r.tail;
    if (Me(e, t, r.children, n), r = ae.current, (r & 2) !== 0) r = r & 1 | 2, t.flags |= 128;
    else {
      if (e !== null && (e.flags & 128) !== 0) e: for (e = t.child; e !== null; ) {
        if (e.tag === 13) e.memoizedState !== null && Gs(e, n, t);
        else if (e.tag === 19) Gs(e, n, t);
        else if (e.child !== null) {
          e.child.return = e, e = e.child;
          continue;
        }
        if (e === t) break e;
        for (; e.sibling === null; ) {
          if (e.return === null || e.return === t) break e;
          e = e.return;
        }
        e.sibling.return = e.return, e = e.sibling;
      }
      r &= 1;
    }
    if (re(ae, r), (t.mode & 1) === 0) t.memoizedState = null;
    else switch (l) {
      case "forwards":
        for (n = t.child, l = null; n !== null; ) e = n.alternate, e !== null && nl(e) === null && (l = n), n = n.sibling;
        n = l, n === null ? (l = t.child, t.child = null) : (l = n.sibling, n.sibling = null), ti(t, !1, l, n, u);
        break;
      case "backwards":
        for (n = null, l = t.child, t.child = null; l !== null; ) {
          if (e = l.alternate, e !== null && nl(e) === null) {
            t.child = l;
            break;
          }
          e = l.sibling, l.sibling = n, n = l, l = e;
        }
        ti(t, !0, n, null, u);
        break;
      case "together":
        ti(t, !1, null, null, void 0);
        break;
      default:
        t.memoizedState = null;
    }
    return t.child;
  }
  function cl(e, t) {
    (t.mode & 1) === 0 && e !== null && (e.alternate = null, t.alternate = null, t.flags |= 2);
  }
  function Et(e, t, n) {
    if (e !== null && (t.dependencies = e.dependencies), nn |= t.lanes, (n & t.childLanes) === 0) return null;
    if (e !== null && t.child !== e.child) throw Error(c(153));
    if (t.child !== null) {
      for (e = t.child, n = Wt(e, e.pendingProps), t.child = n, n.return = t; e.sibling !== null; ) e = e.sibling, n = n.sibling = Wt(e, e.pendingProps), n.return = t;
      n.sibling = null;
    }
    return t.child;
  }
  function pf(e, t, n) {
    switch (t.tag) {
      case 3:
        Ks(t), xn();
        break;
      case 5:
        cs(t);
        break;
      case 1:
        Ue(t.type) && Kr(t);
        break;
      case 4:
        Ou(t, t.stateNode.containerInfo);
        break;
      case 10:
        var r = t.type._context, l = t.memoizedProps.value;
        re(qr, r._currentValue), r._currentValue = l;
        break;
      case 13:
        if (r = t.memoizedState, r !== null)
          return r.dehydrated !== null ? (re(ae, ae.current & 1), t.flags |= 128, null) : (n & t.child.childLanes) !== 0 ? Xs(e, t, n) : (re(ae, ae.current & 1), e = Et(e, t, n), e !== null ? e.sibling : null);
        re(ae, ae.current & 1);
        break;
      case 19:
        if (r = (n & t.childLanes) !== 0, (e.flags & 128) !== 0) {
          if (r) return Zs(e, t, n);
          t.flags |= 128;
        }
        if (l = t.memoizedState, l !== null && (l.rendering = null, l.tail = null, l.lastEffect = null), re(ae, ae.current), r) break;
        return null;
      case 22:
      case 23:
        return t.lanes = 0, Hs(e, t, n);
    }
    return Et(e, t, n);
  }
  var Js, ni, qs, bs;
  Js = function(e, t) {
    for (var n = t.child; n !== null; ) {
      if (n.tag === 5 || n.tag === 6) e.appendChild(n.stateNode);
      else if (n.tag !== 4 && n.child !== null) {
        n.child.return = n, n = n.child;
        continue;
      }
      if (n === t) break;
      for (; n.sibling === null; ) {
        if (n.return === null || n.return === t) return;
        n = n.return;
      }
      n.sibling.return = n.return, n = n.sibling;
    }
  }, ni = function() {
  }, qs = function(e, t, n, r) {
    var l = e.memoizedProps;
    if (l !== r) {
      e = t.stateNode, en(ht.current);
      var u = null;
      switch (n) {
        case "input":
          l = Ll(e, l), r = Ll(e, r), u = [];
          break;
        case "select":
          l = N({}, l, { value: void 0 }), r = N({}, r, { value: void 0 }), u = [];
          break;
        case "textarea":
          l = Ol(e, l), r = Ol(e, r), u = [];
          break;
        default:
          typeof l.onClick != "function" && typeof r.onClick == "function" && (e.onclick = Hr);
      }
      Il(n, r);
      var i;
      n = null;
      for (h in l) if (!r.hasOwnProperty(h) && l.hasOwnProperty(h) && l[h] != null) if (h === "style") {
        var o = l[h];
        for (i in o) o.hasOwnProperty(i) && (n || (n = {}), n[i] = "");
      } else h !== "dangerouslySetInnerHTML" && h !== "children" && h !== "suppressContentEditableWarning" && h !== "suppressHydrationWarning" && h !== "autoFocus" && (U.hasOwnProperty(h) ? u || (u = []) : (u = u || []).push(h, null));
      for (h in r) {
        var s = r[h];
        if (o = l != null ? l[h] : void 0, r.hasOwnProperty(h) && s !== o && (s != null || o != null)) if (h === "style") if (o) {
          for (i in o) !o.hasOwnProperty(i) || s && s.hasOwnProperty(i) || (n || (n = {}), n[i] = "");
          for (i in s) s.hasOwnProperty(i) && o[i] !== s[i] && (n || (n = {}), n[i] = s[i]);
        } else n || (u || (u = []), u.push(
          h,
          n
        )), n = s;
        else h === "dangerouslySetInnerHTML" ? (s = s ? s.__html : void 0, o = o ? o.__html : void 0, s != null && o !== s && (u = u || []).push(h, s)) : h === "children" ? typeof s != "string" && typeof s != "number" || (u = u || []).push(h, "" + s) : h !== "suppressContentEditableWarning" && h !== "suppressHydrationWarning" && (U.hasOwnProperty(h) ? (s != null && h === "onScroll" && le("scroll", e), u || o === s || (u = [])) : (u = u || []).push(h, s));
      }
      n && (u = u || []).push("style", n);
      var h = u;
      (t.updateQueue = h) && (t.flags |= 4);
    }
  }, bs = function(e, t, n, r) {
    n !== r && (t.flags |= 4);
  };
  function dr(e, t) {
    if (!oe) switch (e.tailMode) {
      case "hidden":
        t = e.tail;
        for (var n = null; t !== null; ) t.alternate !== null && (n = t), t = t.sibling;
        n === null ? e.tail = null : n.sibling = null;
        break;
      case "collapsed":
        n = e.tail;
        for (var r = null; n !== null; ) n.alternate !== null && (r = n), n = n.sibling;
        r === null ? t || e.tail === null ? e.tail = null : e.tail.sibling = null : r.sibling = null;
    }
  }
  function Re(e) {
    var t = e.alternate !== null && e.alternate.child === e.child, n = 0, r = 0;
    if (t) for (var l = e.child; l !== null; ) n |= l.lanes | l.childLanes, r |= l.subtreeFlags & 14680064, r |= l.flags & 14680064, l.return = e, l = l.sibling;
    else for (l = e.child; l !== null; ) n |= l.lanes | l.childLanes, r |= l.subtreeFlags, r |= l.flags, l.return = e, l = l.sibling;
    return e.subtreeFlags |= r, e.childLanes = n, t;
  }
  function hf(e, t, n) {
    var r = t.pendingProps;
    switch (Eu(t), t.tag) {
      case 2:
      case 16:
      case 15:
      case 0:
      case 11:
      case 7:
      case 8:
      case 12:
      case 9:
      case 14:
        return Re(t), null;
      case 1:
        return Ue(t.type) && Qr(), Re(t), null;
      case 3:
        return r = t.stateNode, Pn(), ue(Fe), ue(ze), Fu(), r.pendingContext && (r.context = r.pendingContext, r.pendingContext = null), (e === null || e.child === null) && (Zr(t) ? t.flags |= 4 : e === null || e.memoizedState.isDehydrated && (t.flags & 256) === 0 || (t.flags |= 1024, ut !== null && (pi(ut), ut = null))), ni(e, t), Re(t), null;
      case 5:
        Du(t);
        var l = en(or.current);
        if (n = t.type, e !== null && t.stateNode != null) qs(e, t, n, r, l), e.ref !== t.ref && (t.flags |= 512, t.flags |= 2097152);
        else {
          if (!r) {
            if (t.stateNode === null) throw Error(c(166));
            return Re(t), null;
          }
          if (e = en(ht.current), Zr(t)) {
            r = t.stateNode, n = t.type;
            var u = t.memoizedProps;
            switch (r[pt] = t, r[nr] = u, e = (t.mode & 1) !== 0, n) {
              case "dialog":
                le("cancel", r), le("close", r);
                break;
              case "iframe":
              case "object":
              case "embed":
                le("load", r);
                break;
              case "video":
              case "audio":
                for (l = 0; l < bn.length; l++) le(bn[l], r);
                break;
              case "source":
                le("error", r);
                break;
              case "img":
              case "image":
              case "link":
                le(
                  "error",
                  r
                ), le("load", r);
                break;
              case "details":
                le("toggle", r);
                break;
              case "input":
                ji(r, u), le("invalid", r);
                break;
              case "select":
                r._wrapperState = { wasMultiple: !!u.multiple }, le("invalid", r);
                break;
              case "textarea":
                Di(r, u), le("invalid", r);
            }
            Il(n, u), l = null;
            for (var i in u) if (u.hasOwnProperty(i)) {
              var o = u[i];
              i === "children" ? typeof o == "string" ? r.textContent !== o && (u.suppressHydrationWarning !== !0 && Br(r.textContent, o, e), l = ["children", o]) : typeof o == "number" && r.textContent !== "" + o && (u.suppressHydrationWarning !== !0 && Br(
                r.textContent,
                o,
                e
              ), l = ["children", "" + o]) : U.hasOwnProperty(i) && o != null && i === "onScroll" && le("scroll", r);
            }
            switch (n) {
              case "input":
                kr(r), Oi(r, u, !0);
                break;
              case "textarea":
                kr(r), Fi(r);
                break;
              case "select":
              case "option":
                break;
              default:
                typeof u.onClick == "function" && (r.onclick = Hr);
            }
            r = l, t.updateQueue = r, r !== null && (t.flags |= 4);
          } else {
            i = l.nodeType === 9 ? l : l.ownerDocument, e === "http://www.w3.org/1999/xhtml" && (e = Ui(n)), e === "http://www.w3.org/1999/xhtml" ? n === "script" ? (e = i.createElement("div"), e.innerHTML = "<script><\/script>", e = e.removeChild(e.firstChild)) : typeof r.is == "string" ? e = i.createElement(n, { is: r.is }) : (e = i.createElement(n), n === "select" && (i = e, r.multiple ? i.multiple = !0 : r.size && (i.size = r.size))) : e = i.createElementNS(e, n), e[pt] = t, e[nr] = r, Js(e, t, !1, !1), t.stateNode = e;
            e: {
              switch (i = Fl(n, r), n) {
                case "dialog":
                  le("cancel", e), le("close", e), l = r;
                  break;
                case "iframe":
                case "object":
                case "embed":
                  le("load", e), l = r;
                  break;
                case "video":
                case "audio":
                  for (l = 0; l < bn.length; l++) le(bn[l], e);
                  l = r;
                  break;
                case "source":
                  le("error", e), l = r;
                  break;
                case "img":
                case "image":
                case "link":
                  le(
                    "error",
                    e
                  ), le("load", e), l = r;
                  break;
                case "details":
                  le("toggle", e), l = r;
                  break;
                case "input":
                  ji(e, r), l = Ll(e, r), le("invalid", e);
                  break;
                case "option":
                  l = r;
                  break;
                case "select":
                  e._wrapperState = { wasMultiple: !!r.multiple }, l = N({}, r, { value: void 0 }), le("invalid", e);
                  break;
                case "textarea":
                  Di(e, r), l = Ol(e, r), le("invalid", e);
                  break;
                default:
                  l = r;
              }
              Il(n, l), o = l;
              for (u in o) if (o.hasOwnProperty(u)) {
                var s = o[u];
                u === "style" ? $i(e, s) : u === "dangerouslySetInnerHTML" ? (s = s ? s.__html : void 0, s != null && Ai(e, s)) : u === "children" ? typeof s == "string" ? (n !== "textarea" || s !== "") && On(e, s) : typeof s == "number" && On(e, "" + s) : u !== "suppressContentEditableWarning" && u !== "suppressHydrationWarning" && u !== "autoFocus" && (U.hasOwnProperty(u) ? s != null && u === "onScroll" && le("scroll", e) : s != null && ye(e, u, s, i));
              }
              switch (n) {
                case "input":
                  kr(e), Oi(e, r, !1);
                  break;
                case "textarea":
                  kr(e), Fi(e);
                  break;
                case "option":
                  r.value != null && e.setAttribute("value", "" + q(r.value));
                  break;
                case "select":
                  e.multiple = !!r.multiple, u = r.value, u != null ? sn(e, !!r.multiple, u, !1) : r.defaultValue != null && sn(
                    e,
                    !!r.multiple,
                    r.defaultValue,
                    !0
                  );
                  break;
                default:
                  typeof l.onClick == "function" && (e.onclick = Hr);
              }
              switch (n) {
                case "button":
                case "input":
                case "select":
                case "textarea":
                  r = !!r.autoFocus;
                  break e;
                case "img":
                  r = !0;
                  break e;
                default:
                  r = !1;
              }
            }
            r && (t.flags |= 4);
          }
          t.ref !== null && (t.flags |= 512, t.flags |= 2097152);
        }
        return Re(t), null;
      case 6:
        if (e && t.stateNode != null) bs(e, t, e.memoizedProps, r);
        else {
          if (typeof r != "string" && t.stateNode === null) throw Error(c(166));
          if (n = en(or.current), en(ht.current), Zr(t)) {
            if (r = t.stateNode, n = t.memoizedProps, r[pt] = t, (u = r.nodeValue !== n) && (e = Ke, e !== null)) switch (e.tag) {
              case 3:
                Br(r.nodeValue, n, (e.mode & 1) !== 0);
                break;
              case 5:
                e.memoizedProps.suppressHydrationWarning !== !0 && Br(r.nodeValue, n, (e.mode & 1) !== 0);
            }
            u && (t.flags |= 4);
          } else r = (n.nodeType === 9 ? n : n.ownerDocument).createTextNode(r), r[pt] = t, t.stateNode = r;
        }
        return Re(t), null;
      case 13:
        if (ue(ae), r = t.memoizedState, e === null || e.memoizedState !== null && e.memoizedState.dehydrated !== null) {
          if (oe && Ye !== null && (t.mode & 1) !== 0 && (t.flags & 128) === 0) ns(), xn(), t.flags |= 98560, u = !1;
          else if (u = Zr(t), r !== null && r.dehydrated !== null) {
            if (e === null) {
              if (!u) throw Error(c(318));
              if (u = t.memoizedState, u = u !== null ? u.dehydrated : null, !u) throw Error(c(317));
              u[pt] = t;
            } else xn(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            Re(t), u = !1;
          } else ut !== null && (pi(ut), ut = null), u = !0;
          if (!u) return t.flags & 65536 ? t : null;
        }
        return (t.flags & 128) !== 0 ? (t.lanes = n, t) : (r = r !== null, r !== (e !== null && e.memoizedState !== null) && r && (t.child.flags |= 8192, (t.mode & 1) !== 0 && (e === null || (ae.current & 1) !== 0 ? we === 0 && (we = 3) : vi())), t.updateQueue !== null && (t.flags |= 4), Re(t), null);
      case 4:
        return Pn(), ni(e, t), e === null && er(t.stateNode.containerInfo), Re(t), null;
      case 10:
        return Ru(t.type._context), Re(t), null;
      case 17:
        return Ue(t.type) && Qr(), Re(t), null;
      case 19:
        if (ue(ae), u = t.memoizedState, u === null) return Re(t), null;
        if (r = (t.flags & 128) !== 0, i = u.rendering, i === null) if (r) dr(u, !1);
        else {
          if (we !== 0 || e !== null && (e.flags & 128) !== 0) for (e = t.child; e !== null; ) {
            if (i = nl(e), i !== null) {
              for (t.flags |= 128, dr(u, !1), r = i.updateQueue, r !== null && (t.updateQueue = r, t.flags |= 4), t.subtreeFlags = 0, r = n, n = t.child; n !== null; ) u = n, e = r, u.flags &= 14680066, i = u.alternate, i === null ? (u.childLanes = 0, u.lanes = e, u.child = null, u.subtreeFlags = 0, u.memoizedProps = null, u.memoizedState = null, u.updateQueue = null, u.dependencies = null, u.stateNode = null) : (u.childLanes = i.childLanes, u.lanes = i.lanes, u.child = i.child, u.subtreeFlags = 0, u.deletions = null, u.memoizedProps = i.memoizedProps, u.memoizedState = i.memoizedState, u.updateQueue = i.updateQueue, u.type = i.type, e = i.dependencies, u.dependencies = e === null ? null : { lanes: e.lanes, firstContext: e.firstContext }), n = n.sibling;
              return re(ae, ae.current & 1 | 2), t.child;
            }
            e = e.sibling;
          }
          u.tail !== null && he() > Ln && (t.flags |= 128, r = !0, dr(u, !1), t.lanes = 4194304);
        }
        else {
          if (!r) if (e = nl(i), e !== null) {
            if (t.flags |= 128, r = !0, n = e.updateQueue, n !== null && (t.updateQueue = n, t.flags |= 4), dr(u, !0), u.tail === null && u.tailMode === "hidden" && !i.alternate && !oe) return Re(t), null;
          } else 2 * he() - u.renderingStartTime > Ln && n !== 1073741824 && (t.flags |= 128, r = !0, dr(u, !1), t.lanes = 4194304);
          u.isBackwards ? (i.sibling = t.child, t.child = i) : (n = u.last, n !== null ? n.sibling = i : t.child = i, u.last = i);
        }
        return u.tail !== null ? (t = u.tail, u.rendering = t, u.tail = t.sibling, u.renderingStartTime = he(), t.sibling = null, n = ae.current, re(ae, r ? n & 1 | 2 : n & 1), t) : (Re(t), null);
      case 22:
      case 23:
        return mi(), r = t.memoizedState !== null, e !== null && e.memoizedState !== null !== r && (t.flags |= 8192), r && (t.mode & 1) !== 0 ? (Xe & 1073741824) !== 0 && (Re(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : Re(t), null;
      case 24:
        return null;
      case 25:
        return null;
    }
    throw Error(c(156, t.tag));
  }
  function mf(e, t) {
    switch (Eu(t), t.tag) {
      case 1:
        return Ue(t.type) && Qr(), e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
      case 3:
        return Pn(), ue(Fe), ue(ze), Fu(), e = t.flags, (e & 65536) !== 0 && (e & 128) === 0 ? (t.flags = e & -65537 | 128, t) : null;
      case 5:
        return Du(t), null;
      case 13:
        if (ue(ae), e = t.memoizedState, e !== null && e.dehydrated !== null) {
          if (t.alternate === null) throw Error(c(340));
          xn();
        }
        return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
      case 19:
        return ue(ae), null;
      case 4:
        return Pn(), null;
      case 10:
        return Ru(t.type._context), null;
      case 22:
      case 23:
        return mi(), null;
      case 24:
        return null;
      default:
        return null;
    }
  }
  var fl = !1, Le = !1, vf = typeof WeakSet == "function" ? WeakSet : Set, E = null;
  function Tn(e, t) {
    var n = e.ref;
    if (n !== null) if (typeof n == "function") try {
      n(null);
    } catch (r) {
      de(e, t, r);
    }
    else n.current = null;
  }
  function ri(e, t, n) {
    try {
      n();
    } catch (r) {
      de(e, t, r);
    }
  }
  var ea = !1;
  function yf(e, t) {
    if (mu = Lr, e = jo(), ou(e)) {
      if ("selectionStart" in e) var n = { start: e.selectionStart, end: e.selectionEnd };
      else e: {
        n = (n = e.ownerDocument) && n.defaultView || window;
        var r = n.getSelection && n.getSelection();
        if (r && r.rangeCount !== 0) {
          n = r.anchorNode;
          var l = r.anchorOffset, u = r.focusNode;
          r = r.focusOffset;
          try {
            n.nodeType, u.nodeType;
          } catch {
            n = null;
            break e;
          }
          var i = 0, o = -1, s = -1, h = 0, k = 0, w = e, y = null;
          t: for (; ; ) {
            for (var x; w !== n || l !== 0 && w.nodeType !== 3 || (o = i + l), w !== u || r !== 0 && w.nodeType !== 3 || (s = i + r), w.nodeType === 3 && (i += w.nodeValue.length), (x = w.firstChild) !== null; )
              y = w, w = x;
            for (; ; ) {
              if (w === e) break t;
              if (y === n && ++h === l && (o = i), y === u && ++k === r && (s = i), (x = w.nextSibling) !== null) break;
              w = y, y = w.parentNode;
            }
            w = x;
          }
          n = o === -1 || s === -1 ? null : { start: o, end: s };
        } else n = null;
      }
      n = n || { start: 0, end: 0 };
    } else n = null;
    for (vu = { focusedElem: e, selectionRange: n }, Lr = !1, E = t; E !== null; ) if (t = E, e = t.child, (t.subtreeFlags & 1028) !== 0 && e !== null) e.return = t, E = e;
    else for (; E !== null; ) {
      t = E;
      try {
        var P = t.alternate;
        if ((t.flags & 1024) !== 0) switch (t.tag) {
          case 0:
          case 11:
          case 15:
            break;
          case 1:
            if (P !== null) {
              var z = P.memoizedProps, me = P.memoizedState, d = t.stateNode, a = d.getSnapshotBeforeUpdate(t.elementType === t.type ? z : it(t.type, z), me);
              d.__reactInternalSnapshotBeforeUpdate = a;
            }
            break;
          case 3:
            var p = t.stateNode.containerInfo;
            p.nodeType === 1 ? p.textContent = "" : p.nodeType === 9 && p.documentElement && p.removeChild(p.documentElement);
            break;
          case 5:
          case 6:
          case 4:
          case 17:
            break;
          default:
            throw Error(c(163));
        }
      } catch (S) {
        de(t, t.return, S);
      }
      if (e = t.sibling, e !== null) {
        e.return = t.return, E = e;
        break;
      }
      E = t.return;
    }
    return P = ea, ea = !1, P;
  }
  function pr(e, t, n) {
    var r = t.updateQueue;
    if (r = r !== null ? r.lastEffect : null, r !== null) {
      var l = r = r.next;
      do {
        if ((l.tag & e) === e) {
          var u = l.destroy;
          l.destroy = void 0, u !== void 0 && ri(t, n, u);
        }
        l = l.next;
      } while (l !== r);
    }
  }
  function dl(e, t) {
    if (t = t.updateQueue, t = t !== null ? t.lastEffect : null, t !== null) {
      var n = t = t.next;
      do {
        if ((n.tag & e) === e) {
          var r = n.create;
          n.destroy = r();
        }
        n = n.next;
      } while (n !== t);
    }
  }
  function li(e) {
    var t = e.ref;
    if (t !== null) {
      var n = e.stateNode;
      switch (e.tag) {
        case 5:
          e = n;
          break;
        default:
          e = n;
      }
      typeof t == "function" ? t(e) : t.current = e;
    }
  }
  function ta(e) {
    var t = e.alternate;
    t !== null && (e.alternate = null, ta(t)), e.child = null, e.deletions = null, e.sibling = null, e.tag === 5 && (t = e.stateNode, t !== null && (delete t[pt], delete t[nr], delete t[wu], delete t[qc], delete t[bc])), e.stateNode = null, e.return = null, e.dependencies = null, e.memoizedProps = null, e.memoizedState = null, e.pendingProps = null, e.stateNode = null, e.updateQueue = null;
  }
  function na(e) {
    return e.tag === 5 || e.tag === 3 || e.tag === 4;
  }
  function ra(e) {
    e: for (; ; ) {
      for (; e.sibling === null; ) {
        if (e.return === null || na(e.return)) return null;
        e = e.return;
      }
      for (e.sibling.return = e.return, e = e.sibling; e.tag !== 5 && e.tag !== 6 && e.tag !== 18; ) {
        if (e.flags & 2 || e.child === null || e.tag === 4) continue e;
        e.child.return = e, e = e.child;
      }
      if (!(e.flags & 2)) return e.stateNode;
    }
  }
  function ui(e, t, n) {
    var r = e.tag;
    if (r === 5 || r === 6) e = e.stateNode, t ? n.nodeType === 8 ? n.parentNode.insertBefore(e, t) : n.insertBefore(e, t) : (n.nodeType === 8 ? (t = n.parentNode, t.insertBefore(e, n)) : (t = n, t.appendChild(e)), n = n._reactRootContainer, n != null || t.onclick !== null || (t.onclick = Hr));
    else if (r !== 4 && (e = e.child, e !== null)) for (ui(e, t, n), e = e.sibling; e !== null; ) ui(e, t, n), e = e.sibling;
  }
  function ii(e, t, n) {
    var r = e.tag;
    if (r === 5 || r === 6) e = e.stateNode, t ? n.insertBefore(e, t) : n.appendChild(e);
    else if (r !== 4 && (e = e.child, e !== null)) for (ii(e, t, n), e = e.sibling; e !== null; ) ii(e, t, n), e = e.sibling;
  }
  var Ee = null, ot = !1;
  function At(e, t, n) {
    for (n = n.child; n !== null; ) la(e, t, n), n = n.sibling;
  }
  function la(e, t, n) {
    if (dt && typeof dt.onCommitFiberUnmount == "function") try {
      dt.onCommitFiberUnmount(Cr, n);
    } catch {
    }
    switch (n.tag) {
      case 5:
        Le || Tn(n, t);
      case 6:
        var r = Ee, l = ot;
        Ee = null, At(e, t, n), Ee = r, ot = l, Ee !== null && (ot ? (e = Ee, n = n.stateNode, e.nodeType === 8 ? e.parentNode.removeChild(n) : e.removeChild(n)) : Ee.removeChild(n.stateNode));
        break;
      case 18:
        Ee !== null && (ot ? (e = Ee, n = n.stateNode, e.nodeType === 8 ? ku(e.parentNode, n) : e.nodeType === 1 && ku(e, n), Qn(e)) : ku(Ee, n.stateNode));
        break;
      case 4:
        r = Ee, l = ot, Ee = n.stateNode.containerInfo, ot = !0, At(e, t, n), Ee = r, ot = l;
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        if (!Le && (r = n.updateQueue, r !== null && (r = r.lastEffect, r !== null))) {
          l = r = r.next;
          do {
            var u = l, i = u.destroy;
            u = u.tag, i !== void 0 && ((u & 2) !== 0 || (u & 4) !== 0) && ri(n, t, i), l = l.next;
          } while (l !== r);
        }
        At(e, t, n);
        break;
      case 1:
        if (!Le && (Tn(n, t), r = n.stateNode, typeof r.componentWillUnmount == "function")) try {
          r.props = n.memoizedProps, r.state = n.memoizedState, r.componentWillUnmount();
        } catch (o) {
          de(n, t, o);
        }
        At(e, t, n);
        break;
      case 21:
        At(e, t, n);
        break;
      case 22:
        n.mode & 1 ? (Le = (r = Le) || n.memoizedState !== null, At(e, t, n), Le = r) : At(e, t, n);
        break;
      default:
        At(e, t, n);
    }
  }
  function ua(e) {
    var t = e.updateQueue;
    if (t !== null) {
      e.updateQueue = null;
      var n = e.stateNode;
      n === null && (n = e.stateNode = new vf()), t.forEach(function(r) {
        var l = Nf.bind(null, e, r);
        n.has(r) || (n.add(r), r.then(l, l));
      });
    }
  }
  function st(e, t) {
    var n = t.deletions;
    if (n !== null) for (var r = 0; r < n.length; r++) {
      var l = n[r];
      try {
        var u = e, i = t, o = i;
        e: for (; o !== null; ) {
          switch (o.tag) {
            case 5:
              Ee = o.stateNode, ot = !1;
              break e;
            case 3:
              Ee = o.stateNode.containerInfo, ot = !0;
              break e;
            case 4:
              Ee = o.stateNode.containerInfo, ot = !0;
              break e;
          }
          o = o.return;
        }
        if (Ee === null) throw Error(c(160));
        la(u, i, l), Ee = null, ot = !1;
        var s = l.alternate;
        s !== null && (s.return = null), l.return = null;
      } catch (h) {
        de(l, t, h);
      }
    }
    if (t.subtreeFlags & 12854) for (t = t.child; t !== null; ) ia(t, e), t = t.sibling;
  }
  function ia(e, t) {
    var n = e.alternate, r = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        if (st(t, e), vt(e), r & 4) {
          try {
            pr(3, e, e.return), dl(3, e);
          } catch (z) {
            de(e, e.return, z);
          }
          try {
            pr(5, e, e.return);
          } catch (z) {
            de(e, e.return, z);
          }
        }
        break;
      case 1:
        st(t, e), vt(e), r & 512 && n !== null && Tn(n, n.return);
        break;
      case 5:
        if (st(t, e), vt(e), r & 512 && n !== null && Tn(n, n.return), e.flags & 32) {
          var l = e.stateNode;
          try {
            On(l, "");
          } catch (z) {
            de(e, e.return, z);
          }
        }
        if (r & 4 && (l = e.stateNode, l != null)) {
          var u = e.memoizedProps, i = n !== null ? n.memoizedProps : u, o = e.type, s = e.updateQueue;
          if (e.updateQueue = null, s !== null) try {
            o === "input" && u.type === "radio" && u.name != null && Mi(l, u), Fl(o, i);
            var h = Fl(o, u);
            for (i = 0; i < s.length; i += 2) {
              var k = s[i], w = s[i + 1];
              k === "style" ? $i(l, w) : k === "dangerouslySetInnerHTML" ? Ai(l, w) : k === "children" ? On(l, w) : ye(l, k, w, h);
            }
            switch (o) {
              case "input":
                jl(l, u);
                break;
              case "textarea":
                Ii(l, u);
                break;
              case "select":
                var y = l._wrapperState.wasMultiple;
                l._wrapperState.wasMultiple = !!u.multiple;
                var x = u.value;
                x != null ? sn(l, !!u.multiple, x, !1) : y !== !!u.multiple && (u.defaultValue != null ? sn(
                  l,
                  !!u.multiple,
                  u.defaultValue,
                  !0
                ) : sn(l, !!u.multiple, u.multiple ? [] : "", !1));
            }
            l[nr] = u;
          } catch (z) {
            de(e, e.return, z);
          }
        }
        break;
      case 6:
        if (st(t, e), vt(e), r & 4) {
          if (e.stateNode === null) throw Error(c(162));
          l = e.stateNode, u = e.memoizedProps;
          try {
            l.nodeValue = u;
          } catch (z) {
            de(e, e.return, z);
          }
        }
        break;
      case 3:
        if (st(t, e), vt(e), r & 4 && n !== null && n.memoizedState.isDehydrated) try {
          Qn(t.containerInfo);
        } catch (z) {
          de(e, e.return, z);
        }
        break;
      case 4:
        st(t, e), vt(e);
        break;
      case 13:
        st(t, e), vt(e), l = e.child, l.flags & 8192 && (u = l.memoizedState !== null, l.stateNode.isHidden = u, !u || l.alternate !== null && l.alternate.memoizedState !== null || (ai = he())), r & 4 && ua(e);
        break;
      case 22:
        if (k = n !== null && n.memoizedState !== null, e.mode & 1 ? (Le = (h = Le) || k, st(t, e), Le = h) : st(t, e), vt(e), r & 8192) {
          if (h = e.memoizedState !== null, (e.stateNode.isHidden = h) && !k && (e.mode & 1) !== 0) for (E = e, k = e.child; k !== null; ) {
            for (w = E = k; E !== null; ) {
              switch (y = E, x = y.child, y.tag) {
                case 0:
                case 11:
                case 14:
                case 15:
                  pr(4, y, y.return);
                  break;
                case 1:
                  Tn(y, y.return);
                  var P = y.stateNode;
                  if (typeof P.componentWillUnmount == "function") {
                    r = y, n = y.return;
                    try {
                      t = r, P.props = t.memoizedProps, P.state = t.memoizedState, P.componentWillUnmount();
                    } catch (z) {
                      de(r, n, z);
                    }
                  }
                  break;
                case 5:
                  Tn(y, y.return);
                  break;
                case 22:
                  if (y.memoizedState !== null) {
                    aa(w);
                    continue;
                  }
              }
              x !== null ? (x.return = y, E = x) : aa(w);
            }
            k = k.sibling;
          }
          e: for (k = null, w = e; ; ) {
            if (w.tag === 5) {
              if (k === null) {
                k = w;
                try {
                  l = w.stateNode, h ? (u = l.style, typeof u.setProperty == "function" ? u.setProperty("display", "none", "important") : u.display = "none") : (o = w.stateNode, s = w.memoizedProps.style, i = s != null && s.hasOwnProperty("display") ? s.display : null, o.style.display = Vi("display", i));
                } catch (z) {
                  de(e, e.return, z);
                }
              }
            } else if (w.tag === 6) {
              if (k === null) try {
                w.stateNode.nodeValue = h ? "" : w.memoizedProps;
              } catch (z) {
                de(e, e.return, z);
              }
            } else if ((w.tag !== 22 && w.tag !== 23 || w.memoizedState === null || w === e) && w.child !== null) {
              w.child.return = w, w = w.child;
              continue;
            }
            if (w === e) break e;
            for (; w.sibling === null; ) {
              if (w.return === null || w.return === e) break e;
              k === w && (k = null), w = w.return;
            }
            k === w && (k = null), w.sibling.return = w.return, w = w.sibling;
          }
        }
        break;
      case 19:
        st(t, e), vt(e), r & 4 && ua(e);
        break;
      case 21:
        break;
      default:
        st(
          t,
          e
        ), vt(e);
    }
  }
  function vt(e) {
    var t = e.flags;
    if (t & 2) {
      try {
        e: {
          for (var n = e.return; n !== null; ) {
            if (na(n)) {
              var r = n;
              break e;
            }
            n = n.return;
          }
          throw Error(c(160));
        }
        switch (r.tag) {
          case 5:
            var l = r.stateNode;
            r.flags & 32 && (On(l, ""), r.flags &= -33);
            var u = ra(e);
            ii(e, u, l);
            break;
          case 3:
          case 4:
            var i = r.stateNode.containerInfo, o = ra(e);
            ui(e, o, i);
            break;
          default:
            throw Error(c(161));
        }
      } catch (s) {
        de(e, e.return, s);
      }
      e.flags &= -3;
    }
    t & 4096 && (e.flags &= -4097);
  }
  function gf(e, t, n) {
    E = e, oa(e);
  }
  function oa(e, t, n) {
    for (var r = (e.mode & 1) !== 0; E !== null; ) {
      var l = E, u = l.child;
      if (l.tag === 22 && r) {
        var i = l.memoizedState !== null || fl;
        if (!i) {
          var o = l.alternate, s = o !== null && o.memoizedState !== null || Le;
          o = fl;
          var h = Le;
          if (fl = i, (Le = s) && !h) for (E = l; E !== null; ) i = E, s = i.child, i.tag === 22 && i.memoizedState !== null ? ca(l) : s !== null ? (s.return = i, E = s) : ca(l);
          for (; u !== null; ) E = u, oa(u), u = u.sibling;
          E = l, fl = o, Le = h;
        }
        sa(e);
      } else (l.subtreeFlags & 8772) !== 0 && u !== null ? (u.return = l, E = u) : sa(e);
    }
  }
  function sa(e) {
    for (; E !== null; ) {
      var t = E;
      if ((t.flags & 8772) !== 0) {
        var n = t.alternate;
        try {
          if ((t.flags & 8772) !== 0) switch (t.tag) {
            case 0:
            case 11:
            case 15:
              Le || dl(5, t);
              break;
            case 1:
              var r = t.stateNode;
              if (t.flags & 4 && !Le) if (n === null) r.componentDidMount();
              else {
                var l = t.elementType === t.type ? n.memoizedProps : it(t.type, n.memoizedProps);
                r.componentDidUpdate(l, n.memoizedState, r.__reactInternalSnapshotBeforeUpdate);
              }
              var u = t.updateQueue;
              u !== null && as(t, u, r);
              break;
            case 3:
              var i = t.updateQueue;
              if (i !== null) {
                if (n = null, t.child !== null) switch (t.child.tag) {
                  case 5:
                    n = t.child.stateNode;
                    break;
                  case 1:
                    n = t.child.stateNode;
                }
                as(t, i, n);
              }
              break;
            case 5:
              var o = t.stateNode;
              if (n === null && t.flags & 4) {
                n = o;
                var s = t.memoizedProps;
                switch (t.type) {
                  case "button":
                  case "input":
                  case "select":
                  case "textarea":
                    s.autoFocus && n.focus();
                    break;
                  case "img":
                    s.src && (n.src = s.src);
                }
              }
              break;
            case 6:
              break;
            case 4:
              break;
            case 12:
              break;
            case 13:
              if (t.memoizedState === null) {
                var h = t.alternate;
                if (h !== null) {
                  var k = h.memoizedState;
                  if (k !== null) {
                    var w = k.dehydrated;
                    w !== null && Qn(w);
                  }
                }
              }
              break;
            case 19:
            case 17:
            case 21:
            case 22:
            case 23:
            case 25:
              break;
            default:
              throw Error(c(163));
          }
          Le || t.flags & 512 && li(t);
        } catch (y) {
          de(t, t.return, y);
        }
      }
      if (t === e) {
        E = null;
        break;
      }
      if (n = t.sibling, n !== null) {
        n.return = t.return, E = n;
        break;
      }
      E = t.return;
    }
  }
  function aa(e) {
    for (; E !== null; ) {
      var t = E;
      if (t === e) {
        E = null;
        break;
      }
      var n = t.sibling;
      if (n !== null) {
        n.return = t.return, E = n;
        break;
      }
      E = t.return;
    }
  }
  function ca(e) {
    for (; E !== null; ) {
      var t = E;
      try {
        switch (t.tag) {
          case 0:
          case 11:
          case 15:
            var n = t.return;
            try {
              dl(4, t);
            } catch (s) {
              de(t, n, s);
            }
            break;
          case 1:
            var r = t.stateNode;
            if (typeof r.componentDidMount == "function") {
              var l = t.return;
              try {
                r.componentDidMount();
              } catch (s) {
                de(t, l, s);
              }
            }
            var u = t.return;
            try {
              li(t);
            } catch (s) {
              de(t, u, s);
            }
            break;
          case 5:
            var i = t.return;
            try {
              li(t);
            } catch (s) {
              de(t, i, s);
            }
        }
      } catch (s) {
        de(t, t.return, s);
      }
      if (t === e) {
        E = null;
        break;
      }
      var o = t.sibling;
      if (o !== null) {
        o.return = t.return, E = o;
        break;
      }
      E = t.return;
    }
  }
  var kf = Math.ceil, pl = ge.ReactCurrentDispatcher, oi = ge.ReactCurrentOwner, et = ge.ReactCurrentBatchConfig, K = 0, _e = null, ve = null, Ce = 0, Xe = 0, Rn = Ot(0), we = 0, hr = null, nn = 0, hl = 0, si = 0, mr = null, Ve = null, ai = 0, Ln = 1 / 0, Ct = null, ml = !1, ci = null, Vt = null, vl = !1, $t = null, yl = 0, vr = 0, fi = null, gl = -1, kl = 0;
  function Oe() {
    return (K & 6) !== 0 ? he() : gl !== -1 ? gl : gl = he();
  }
  function Bt(e) {
    return (e.mode & 1) === 0 ? 1 : (K & 2) !== 0 && Ce !== 0 ? Ce & -Ce : tf.transition !== null ? (kl === 0 && (kl = no()), kl) : (e = b, e !== 0 || (e = window.event, e = e === void 0 ? 16 : fo(e.type)), e);
  }
  function at(e, t, n, r) {
    if (50 < vr) throw vr = 0, fi = null, Error(c(185));
    Vn(e, n, r), ((K & 2) === 0 || e !== _e) && (e === _e && ((K & 2) === 0 && (hl |= n), we === 4 && Ht(e, Ce)), $e(e, r), n === 1 && K === 0 && (t.mode & 1) === 0 && (Ln = he() + 500, Yr && It()));
  }
  function $e(e, t) {
    var n = e.callbackNode;
    tc(e, t);
    var r = zr(e, e === _e ? Ce : 0);
    if (r === 0) n !== null && bi(n), e.callbackNode = null, e.callbackPriority = 0;
    else if (t = r & -r, e.callbackPriority !== t) {
      if (n != null && bi(n), t === 1) e.tag === 0 ? ef(da.bind(null, e)) : Jo(da.bind(null, e)), Zc(function() {
        (K & 6) === 0 && It();
      }), n = null;
      else {
        switch (ro(r)) {
          case 1:
            n = Wl;
            break;
          case 4:
            n = eo;
            break;
          case 16:
            n = Er;
            break;
          case 536870912:
            n = to;
            break;
          default:
            n = Er;
        }
        n = wa(n, fa.bind(null, e));
      }
      e.callbackPriority = t, e.callbackNode = n;
    }
  }
  function fa(e, t) {
    if (gl = -1, kl = 0, (K & 6) !== 0) throw Error(c(327));
    var n = e.callbackNode;
    if (jn() && e.callbackNode !== n) return null;
    var r = zr(e, e === _e ? Ce : 0);
    if (r === 0) return null;
    if ((r & 30) !== 0 || (r & e.expiredLanes) !== 0 || t) t = wl(e, r);
    else {
      t = r;
      var l = K;
      K |= 2;
      var u = ha();
      (_e !== e || Ce !== t) && (Ct = null, Ln = he() + 500, ln(e, t));
      do
        try {
          _f();
          break;
        } catch (o) {
          pa(e, o);
        }
      while (!0);
      Tu(), pl.current = u, K = l, ve !== null ? t = 0 : (_e = null, Ce = 0, t = we);
    }
    if (t !== 0) {
      if (t === 2 && (l = Ql(e), l !== 0 && (r = l, t = di(e, l))), t === 1) throw n = hr, ln(e, 0), Ht(e, r), $e(e, he()), n;
      if (t === 6) Ht(e, r);
      else {
        if (l = e.current.alternate, (r & 30) === 0 && !wf(l) && (t = wl(e, r), t === 2 && (u = Ql(e), u !== 0 && (r = u, t = di(e, u))), t === 1)) throw n = hr, ln(e, 0), Ht(e, r), $e(e, he()), n;
        switch (e.finishedWork = l, e.finishedLanes = r, t) {
          case 0:
          case 1:
            throw Error(c(345));
          case 2:
            un(e, Ve, Ct);
            break;
          case 3:
            if (Ht(e, r), (r & 130023424) === r && (t = ai + 500 - he(), 10 < t)) {
              if (zr(e, 0) !== 0) break;
              if (l = e.suspendedLanes, (l & r) !== r) {
                Oe(), e.pingedLanes |= e.suspendedLanes & l;
                break;
              }
              e.timeoutHandle = gu(un.bind(null, e, Ve, Ct), t);
              break;
            }
            un(e, Ve, Ct);
            break;
          case 4:
            if (Ht(e, r), (r & 4194240) === r) break;
            for (t = e.eventTimes, l = -1; 0 < r; ) {
              var i = 31 - rt(r);
              u = 1 << i, i = t[i], i > l && (l = i), r &= ~u;
            }
            if (r = l, r = he() - r, r = (120 > r ? 120 : 480 > r ? 480 : 1080 > r ? 1080 : 1920 > r ? 1920 : 3e3 > r ? 3e3 : 4320 > r ? 4320 : 1960 * kf(r / 1960)) - r, 10 < r) {
              e.timeoutHandle = gu(un.bind(null, e, Ve, Ct), r);
              break;
            }
            un(e, Ve, Ct);
            break;
          case 5:
            un(e, Ve, Ct);
            break;
          default:
            throw Error(c(329));
        }
      }
    }
    return $e(e, he()), e.callbackNode === n ? fa.bind(null, e) : null;
  }
  function di(e, t) {
    var n = mr;
    return e.current.memoizedState.isDehydrated && (ln(e, t).flags |= 256), e = wl(e, t), e !== 2 && (t = Ve, Ve = n, t !== null && pi(t)), e;
  }
  function pi(e) {
    Ve === null ? Ve = e : Ve.push.apply(Ve, e);
  }
  function wf(e) {
    for (var t = e; ; ) {
      if (t.flags & 16384) {
        var n = t.updateQueue;
        if (n !== null && (n = n.stores, n !== null)) for (var r = 0; r < n.length; r++) {
          var l = n[r], u = l.getSnapshot;
          l = l.value;
          try {
            if (!lt(u(), l)) return !1;
          } catch {
            return !1;
          }
        }
      }
      if (n = t.child, t.subtreeFlags & 16384 && n !== null) n.return = t, t = n;
      else {
        if (t === e) break;
        for (; t.sibling === null; ) {
          if (t.return === null || t.return === e) return !0;
          t = t.return;
        }
        t.sibling.return = t.return, t = t.sibling;
      }
    }
    return !0;
  }
  function Ht(e, t) {
    for (t &= ~si, t &= ~hl, e.suspendedLanes |= t, e.pingedLanes &= ~t, e = e.expirationTimes; 0 < t; ) {
      var n = 31 - rt(t), r = 1 << n;
      e[n] = -1, t &= ~r;
    }
  }
  function da(e) {
    if ((K & 6) !== 0) throw Error(c(327));
    jn();
    var t = zr(e, 0);
    if ((t & 1) === 0) return $e(e, he()), null;
    var n = wl(e, t);
    if (e.tag !== 0 && n === 2) {
      var r = Ql(e);
      r !== 0 && (t = r, n = di(e, r));
    }
    if (n === 1) throw n = hr, ln(e, 0), Ht(e, t), $e(e, he()), n;
    if (n === 6) throw Error(c(345));
    return e.finishedWork = e.current.alternate, e.finishedLanes = t, un(e, Ve, Ct), $e(e, he()), null;
  }
  function hi(e, t) {
    var n = K;
    K |= 1;
    try {
      return e(t);
    } finally {
      K = n, K === 0 && (Ln = he() + 500, Yr && It());
    }
  }
  function rn(e) {
    $t !== null && $t.tag === 0 && (K & 6) === 0 && jn();
    var t = K;
    K |= 1;
    var n = et.transition, r = b;
    try {
      if (et.transition = null, b = 1, e) return e();
    } finally {
      b = r, et.transition = n, K = t, (K & 6) === 0 && It();
    }
  }
  function mi() {
    Xe = Rn.current, ue(Rn);
  }
  function ln(e, t) {
    e.finishedWork = null, e.finishedLanes = 0;
    var n = e.timeoutHandle;
    if (n !== -1 && (e.timeoutHandle = -1, Gc(n)), ve !== null) for (n = ve.return; n !== null; ) {
      var r = n;
      switch (Eu(r), r.tag) {
        case 1:
          r = r.type.childContextTypes, r != null && Qr();
          break;
        case 3:
          Pn(), ue(Fe), ue(ze), Fu();
          break;
        case 5:
          Du(r);
          break;
        case 4:
          Pn();
          break;
        case 13:
          ue(ae);
          break;
        case 19:
          ue(ae);
          break;
        case 10:
          Ru(r.type._context);
          break;
        case 22:
        case 23:
          mi();
      }
      n = n.return;
    }
    if (_e = e, ve = e = Wt(e.current, null), Ce = Xe = t, we = 0, hr = null, si = hl = nn = 0, Ve = mr = null, bt !== null) {
      for (t = 0; t < bt.length; t++) if (n = bt[t], r = n.interleaved, r !== null) {
        n.interleaved = null;
        var l = r.next, u = n.pending;
        if (u !== null) {
          var i = u.next;
          u.next = l, r.next = i;
        }
        n.pending = r;
      }
      bt = null;
    }
    return e;
  }
  function pa(e, t) {
    do {
      var n = ve;
      try {
        if (Tu(), rl.current = ol, ll) {
          for (var r = ce.memoizedState; r !== null; ) {
            var l = r.queue;
            l !== null && (l.pending = null), r = r.next;
          }
          ll = !1;
        }
        if (tn = 0, Se = ke = ce = null, sr = !1, ar = 0, oi.current = null, n === null || n.return === null) {
          we = 1, hr = t, ve = null;
          break;
        }
        e: {
          var u = e, i = n.return, o = n, s = t;
          if (t = Ce, o.flags |= 32768, s !== null && typeof s == "object" && typeof s.then == "function") {
            var h = s, k = o, w = k.tag;
            if ((k.mode & 1) === 0 && (w === 0 || w === 11 || w === 15)) {
              var y = k.alternate;
              y ? (k.updateQueue = y.updateQueue, k.memoizedState = y.memoizedState, k.lanes = y.lanes) : (k.updateQueue = null, k.memoizedState = null);
            }
            var x = Us(i);
            if (x !== null) {
              x.flags &= -257, As(x, i, o, u, t), x.mode & 1 && Fs(u, h, t), t = x, s = h;
              var P = t.updateQueue;
              if (P === null) {
                var z = /* @__PURE__ */ new Set();
                z.add(s), t.updateQueue = z;
              } else P.add(s);
              break e;
            } else {
              if ((t & 1) === 0) {
                Fs(u, h, t), vi();
                break e;
              }
              s = Error(c(426));
            }
          } else if (oe && o.mode & 1) {
            var me = Us(i);
            if (me !== null) {
              (me.flags & 65536) === 0 && (me.flags |= 256), As(me, i, o, u, t), Pu(zn(s, o));
              break e;
            }
          }
          u = s = zn(s, o), we !== 4 && (we = 2), mr === null ? mr = [u] : mr.push(u), u = i;
          do {
            switch (u.tag) {
              case 3:
                u.flags |= 65536, t &= -t, u.lanes |= t;
                var d = Ds(u, s, t);
                ss(u, d);
                break e;
              case 1:
                o = s;
                var a = u.type, p = u.stateNode;
                if ((u.flags & 128) === 0 && (typeof a.getDerivedStateFromError == "function" || p !== null && typeof p.componentDidCatch == "function" && (Vt === null || !Vt.has(p)))) {
                  u.flags |= 65536, t &= -t, u.lanes |= t;
                  var S = Is(u, o, t);
                  ss(u, S);
                  break e;
                }
            }
            u = u.return;
          } while (u !== null);
        }
        va(n);
      } catch (R) {
        t = R, ve === n && n !== null && (ve = n = n.return);
        continue;
      }
      break;
    } while (!0);
  }
  function ha() {
    var e = pl.current;
    return pl.current = ol, e === null ? ol : e;
  }
  function vi() {
    (we === 0 || we === 3 || we === 2) && (we = 4), _e === null || (nn & 268435455) === 0 && (hl & 268435455) === 0 || Ht(_e, Ce);
  }
  function wl(e, t) {
    var n = K;
    K |= 2;
    var r = ha();
    (_e !== e || Ce !== t) && (Ct = null, ln(e, t));
    do
      try {
        Sf();
        break;
      } catch (l) {
        pa(e, l);
      }
    while (!0);
    if (Tu(), K = n, pl.current = r, ve !== null) throw Error(c(261));
    return _e = null, Ce = 0, we;
  }
  function Sf() {
    for (; ve !== null; ) ma(ve);
  }
  function _f() {
    for (; ve !== null && !Ka(); ) ma(ve);
  }
  function ma(e) {
    var t = ka(e.alternate, e, Xe);
    e.memoizedProps = e.pendingProps, t === null ? va(e) : ve = t, oi.current = null;
  }
  function va(e) {
    var t = e;
    do {
      var n = t.alternate;
      if (e = t.return, (t.flags & 32768) === 0) {
        if (n = hf(n, t, Xe), n !== null) {
          ve = n;
          return;
        }
      } else {
        if (n = mf(n, t), n !== null) {
          n.flags &= 32767, ve = n;
          return;
        }
        if (e !== null) e.flags |= 32768, e.subtreeFlags = 0, e.deletions = null;
        else {
          we = 6, ve = null;
          return;
        }
      }
      if (t = t.sibling, t !== null) {
        ve = t;
        return;
      }
      ve = t = e;
    } while (t !== null);
    we === 0 && (we = 5);
  }
  function un(e, t, n) {
    var r = b, l = et.transition;
    try {
      et.transition = null, b = 1, xf(e, t, n, r);
    } finally {
      et.transition = l, b = r;
    }
    return null;
  }
  function xf(e, t, n, r) {
    do
      jn();
    while ($t !== null);
    if ((K & 6) !== 0) throw Error(c(327));
    n = e.finishedWork;
    var l = e.finishedLanes;
    if (n === null) return null;
    if (e.finishedWork = null, e.finishedLanes = 0, n === e.current) throw Error(c(177));
    e.callbackNode = null, e.callbackPriority = 0;
    var u = n.lanes | n.childLanes;
    if (nc(e, u), e === _e && (ve = _e = null, Ce = 0), (n.subtreeFlags & 2064) === 0 && (n.flags & 2064) === 0 || vl || (vl = !0, wa(Er, function() {
      return jn(), null;
    })), u = (n.flags & 15990) !== 0, (n.subtreeFlags & 15990) !== 0 || u) {
      u = et.transition, et.transition = null;
      var i = b;
      b = 1;
      var o = K;
      K |= 4, oi.current = null, yf(e, n), ia(n, e), Bc(vu), Lr = !!mu, vu = mu = null, e.current = n, gf(n), Ya(), K = o, b = i, et.transition = u;
    } else e.current = n;
    if (vl && (vl = !1, $t = e, yl = l), u = e.pendingLanes, u === 0 && (Vt = null), Za(n.stateNode), $e(e, he()), t !== null) for (r = e.onRecoverableError, n = 0; n < t.length; n++) l = t[n], r(l.value, { componentStack: l.stack, digest: l.digest });
    if (ml) throw ml = !1, e = ci, ci = null, e;
    return (yl & 1) !== 0 && e.tag !== 0 && jn(), u = e.pendingLanes, (u & 1) !== 0 ? e === fi ? vr++ : (vr = 0, fi = e) : vr = 0, It(), null;
  }
  function jn() {
    if ($t !== null) {
      var e = ro(yl), t = et.transition, n = b;
      try {
        if (et.transition = null, b = 16 > e ? 16 : e, $t === null) var r = !1;
        else {
          if (e = $t, $t = null, yl = 0, (K & 6) !== 0) throw Error(c(331));
          var l = K;
          for (K |= 4, E = e.current; E !== null; ) {
            var u = E, i = u.child;
            if ((E.flags & 16) !== 0) {
              var o = u.deletions;
              if (o !== null) {
                for (var s = 0; s < o.length; s++) {
                  var h = o[s];
                  for (E = h; E !== null; ) {
                    var k = E;
                    switch (k.tag) {
                      case 0:
                      case 11:
                      case 15:
                        pr(8, k, u);
                    }
                    var w = k.child;
                    if (w !== null) w.return = k, E = w;
                    else for (; E !== null; ) {
                      k = E;
                      var y = k.sibling, x = k.return;
                      if (ta(k), k === h) {
                        E = null;
                        break;
                      }
                      if (y !== null) {
                        y.return = x, E = y;
                        break;
                      }
                      E = x;
                    }
                  }
                }
                var P = u.alternate;
                if (P !== null) {
                  var z = P.child;
                  if (z !== null) {
                    P.child = null;
                    do {
                      var me = z.sibling;
                      z.sibling = null, z = me;
                    } while (z !== null);
                  }
                }
                E = u;
              }
            }
            if ((u.subtreeFlags & 2064) !== 0 && i !== null) i.return = u, E = i;
            else e: for (; E !== null; ) {
              if (u = E, (u.flags & 2048) !== 0) switch (u.tag) {
                case 0:
                case 11:
                case 15:
                  pr(9, u, u.return);
              }
              var d = u.sibling;
              if (d !== null) {
                d.return = u.return, E = d;
                break e;
              }
              E = u.return;
            }
          }
          var a = e.current;
          for (E = a; E !== null; ) {
            i = E;
            var p = i.child;
            if ((i.subtreeFlags & 2064) !== 0 && p !== null) p.return = i, E = p;
            else e: for (i = a; E !== null; ) {
              if (o = E, (o.flags & 2048) !== 0) try {
                switch (o.tag) {
                  case 0:
                  case 11:
                  case 15:
                    dl(9, o);
                }
              } catch (R) {
                de(o, o.return, R);
              }
              if (o === i) {
                E = null;
                break e;
              }
              var S = o.sibling;
              if (S !== null) {
                S.return = o.return, E = S;
                break e;
              }
              E = o.return;
            }
          }
          if (K = l, It(), dt && typeof dt.onPostCommitFiberRoot == "function") try {
            dt.onPostCommitFiberRoot(Cr, e);
          } catch {
          }
          r = !0;
        }
        return r;
      } finally {
        b = n, et.transition = t;
      }
    }
    return !1;
  }
  function ya(e, t, n) {
    t = zn(n, t), t = Ds(e, t, 1), e = Ut(e, t, 1), t = Oe(), e !== null && (Vn(e, 1, t), $e(e, t));
  }
  function de(e, t, n) {
    if (e.tag === 3) ya(e, e, n);
    else for (; t !== null; ) {
      if (t.tag === 3) {
        ya(t, e, n);
        break;
      } else if (t.tag === 1) {
        var r = t.stateNode;
        if (typeof t.type.getDerivedStateFromError == "function" || typeof r.componentDidCatch == "function" && (Vt === null || !Vt.has(r))) {
          e = zn(n, e), e = Is(t, e, 1), t = Ut(t, e, 1), e = Oe(), t !== null && (Vn(t, 1, e), $e(t, e));
          break;
        }
      }
      t = t.return;
    }
  }
  function Ef(e, t, n) {
    var r = e.pingCache;
    r !== null && r.delete(t), t = Oe(), e.pingedLanes |= e.suspendedLanes & n, _e === e && (Ce & n) === n && (we === 4 || we === 3 && (Ce & 130023424) === Ce && 500 > he() - ai ? ln(e, 0) : si |= n), $e(e, t);
  }
  function ga(e, t) {
    t === 0 && ((e.mode & 1) === 0 ? t = 1 : (t = Pr, Pr <<= 1, (Pr & 130023424) === 0 && (Pr = 4194304)));
    var n = Oe();
    e = _t(e, t), e !== null && (Vn(e, t, n), $e(e, n));
  }
  function Cf(e) {
    var t = e.memoizedState, n = 0;
    t !== null && (n = t.retryLane), ga(e, n);
  }
  function Nf(e, t) {
    var n = 0;
    switch (e.tag) {
      case 13:
        var r = e.stateNode, l = e.memoizedState;
        l !== null && (n = l.retryLane);
        break;
      case 19:
        r = e.stateNode;
        break;
      default:
        throw Error(c(314));
    }
    r !== null && r.delete(t), ga(e, n);
  }
  var ka;
  ka = function(e, t, n) {
    if (e !== null) if (e.memoizedProps !== t.pendingProps || Fe.current) Ae = !0;
    else {
      if ((e.lanes & n) === 0 && (t.flags & 128) === 0) return Ae = !1, pf(e, t, n);
      Ae = (e.flags & 131072) !== 0;
    }
    else Ae = !1, oe && (t.flags & 1048576) !== 0 && qo(t, Gr, t.index);
    switch (t.lanes = 0, t.tag) {
      case 2:
        var r = t.type;
        cl(e, t), e = t.pendingProps;
        var l = wn(t, ze.current);
        Nn(t, n), l = Vu(null, t, r, e, l, n);
        var u = $u();
        return t.flags |= 1, typeof l == "object" && l !== null && typeof l.render == "function" && l.$$typeof === void 0 ? (t.tag = 1, t.memoizedState = null, t.updateQueue = null, Ue(r) ? (u = !0, Kr(t)) : u = !1, t.memoizedState = l.state !== null && l.state !== void 0 ? l.state : null, Mu(t), l.updater = sl, t.stateNode = l, l._reactInternals = t, Yu(t, r, e, n), t = Ju(null, t, r, !0, u, n)) : (t.tag = 0, oe && u && xu(t), Me(null, t, l, n), t = t.child), t;
      case 16:
        r = t.elementType;
        e: {
          switch (cl(e, t), e = t.pendingProps, l = r._init, r = l(r._payload), t.type = r, l = t.tag = zf(r), e = it(r, e), l) {
            case 0:
              t = Zu(null, t, r, e, n);
              break e;
            case 1:
              t = Qs(null, t, r, e, n);
              break e;
            case 11:
              t = Vs(null, t, r, e, n);
              break e;
            case 14:
              t = $s(null, t, r, it(r.type, e), n);
              break e;
          }
          throw Error(c(
            306,
            r,
            ""
          ));
        }
        return t;
      case 0:
        return r = t.type, l = t.pendingProps, l = t.elementType === r ? l : it(r, l), Zu(e, t, r, l, n);
      case 1:
        return r = t.type, l = t.pendingProps, l = t.elementType === r ? l : it(r, l), Qs(e, t, r, l, n);
      case 3:
        e: {
          if (Ks(t), e === null) throw Error(c(387));
          r = t.pendingProps, u = t.memoizedState, l = u.element, os(e, t), tl(t, r, null, n);
          var i = t.memoizedState;
          if (r = i.element, u.isDehydrated) if (u = { element: r, isDehydrated: !1, cache: i.cache, pendingSuspenseBoundaries: i.pendingSuspenseBoundaries, transitions: i.transitions }, t.updateQueue.baseState = u, t.memoizedState = u, t.flags & 256) {
            l = zn(Error(c(423)), t), t = Ys(e, t, r, n, l);
            break e;
          } else if (r !== l) {
            l = zn(Error(c(424)), t), t = Ys(e, t, r, n, l);
            break e;
          } else for (Ye = Mt(t.stateNode.containerInfo.firstChild), Ke = t, oe = !0, ut = null, n = us(t, null, r, n), t.child = n; n; ) n.flags = n.flags & -3 | 4096, n = n.sibling;
          else {
            if (xn(), r === l) {
              t = Et(e, t, n);
              break e;
            }
            Me(e, t, r, n);
          }
          t = t.child;
        }
        return t;
      case 5:
        return cs(t), e === null && Nu(t), r = t.type, l = t.pendingProps, u = e !== null ? e.memoizedProps : null, i = l.children, yu(r, l) ? i = null : u !== null && yu(r, u) && (t.flags |= 32), Ws(e, t), Me(e, t, i, n), t.child;
      case 6:
        return e === null && Nu(t), null;
      case 13:
        return Xs(e, t, n);
      case 4:
        return Ou(t, t.stateNode.containerInfo), r = t.pendingProps, e === null ? t.child = En(t, null, r, n) : Me(e, t, r, n), t.child;
      case 11:
        return r = t.type, l = t.pendingProps, l = t.elementType === r ? l : it(r, l), Vs(e, t, r, l, n);
      case 7:
        return Me(e, t, t.pendingProps, n), t.child;
      case 8:
        return Me(e, t, t.pendingProps.children, n), t.child;
      case 12:
        return Me(e, t, t.pendingProps.children, n), t.child;
      case 10:
        e: {
          if (r = t.type._context, l = t.pendingProps, u = t.memoizedProps, i = l.value, re(qr, r._currentValue), r._currentValue = i, u !== null) if (lt(u.value, i)) {
            if (u.children === l.children && !Fe.current) {
              t = Et(e, t, n);
              break e;
            }
          } else for (u = t.child, u !== null && (u.return = t); u !== null; ) {
            var o = u.dependencies;
            if (o !== null) {
              i = u.child;
              for (var s = o.firstContext; s !== null; ) {
                if (s.context === r) {
                  if (u.tag === 1) {
                    s = xt(-1, n & -n), s.tag = 2;
                    var h = u.updateQueue;
                    if (h !== null) {
                      h = h.shared;
                      var k = h.pending;
                      k === null ? s.next = s : (s.next = k.next, k.next = s), h.pending = s;
                    }
                  }
                  u.lanes |= n, s = u.alternate, s !== null && (s.lanes |= n), Lu(
                    u.return,
                    n,
                    t
                  ), o.lanes |= n;
                  break;
                }
                s = s.next;
              }
            } else if (u.tag === 10) i = u.type === t.type ? null : u.child;
            else if (u.tag === 18) {
              if (i = u.return, i === null) throw Error(c(341));
              i.lanes |= n, o = i.alternate, o !== null && (o.lanes |= n), Lu(i, n, t), i = u.sibling;
            } else i = u.child;
            if (i !== null) i.return = u;
            else for (i = u; i !== null; ) {
              if (i === t) {
                i = null;
                break;
              }
              if (u = i.sibling, u !== null) {
                u.return = i.return, i = u;
                break;
              }
              i = i.return;
            }
            u = i;
          }
          Me(e, t, l.children, n), t = t.child;
        }
        return t;
      case 9:
        return l = t.type, r = t.pendingProps.children, Nn(t, n), l = qe(l), r = r(l), t.flags |= 1, Me(e, t, r, n), t.child;
      case 14:
        return r = t.type, l = it(r, t.pendingProps), l = it(r.type, l), $s(e, t, r, l, n);
      case 15:
        return Bs(e, t, t.type, t.pendingProps, n);
      case 17:
        return r = t.type, l = t.pendingProps, l = t.elementType === r ? l : it(r, l), cl(e, t), t.tag = 1, Ue(r) ? (e = !0, Kr(t)) : e = !1, Nn(t, n), Ms(t, r, l), Yu(t, r, l, n), Ju(null, t, r, !0, e, n);
      case 19:
        return Zs(e, t, n);
      case 22:
        return Hs(e, t, n);
    }
    throw Error(c(156, t.tag));
  };
  function wa(e, t) {
    return qi(e, t);
  }
  function Pf(e, t, n, r) {
    this.tag = e, this.key = n, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = r, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function tt(e, t, n, r) {
    return new Pf(e, t, n, r);
  }
  function yi(e) {
    return e = e.prototype, !(!e || !e.isReactComponent);
  }
  function zf(e) {
    if (typeof e == "function") return yi(e) ? 1 : 0;
    if (e != null) {
      if (e = e.$$typeof, e === ct) return 11;
      if (e === ft) return 14;
    }
    return 2;
  }
  function Wt(e, t) {
    var n = e.alternate;
    return n === null ? (n = tt(e.tag, t, e.key, e.mode), n.elementType = e.elementType, n.type = e.type, n.stateNode = e.stateNode, n.alternate = e, e.alternate = n) : (n.pendingProps = t, n.type = e.type, n.flags = 0, n.subtreeFlags = 0, n.deletions = null), n.flags = e.flags & 14680064, n.childLanes = e.childLanes, n.lanes = e.lanes, n.child = e.child, n.memoizedProps = e.memoizedProps, n.memoizedState = e.memoizedState, n.updateQueue = e.updateQueue, t = e.dependencies, n.dependencies = t === null ? null : { lanes: t.lanes, firstContext: t.firstContext }, n.sibling = e.sibling, n.index = e.index, n.ref = e.ref, n;
  }
  function Sl(e, t, n, r, l, u) {
    var i = 2;
    if (r = e, typeof e == "function") yi(e) && (i = 1);
    else if (typeof e == "string") i = 5;
    else e: switch (e) {
      case De:
        return on(n.children, l, u, t);
      case Ge:
        i = 8, l |= 8;
        break;
      case Nt:
        return e = tt(12, n, t, l | 2), e.elementType = Nt, e.lanes = u, e;
      case He:
        return e = tt(13, n, t, l), e.elementType = He, e.lanes = u, e;
      case nt:
        return e = tt(19, n, t, l), e.elementType = nt, e.lanes = u, e;
      case fe:
        return _l(n, l, u, t);
      default:
        if (typeof e == "object" && e !== null) switch (e.$$typeof) {
          case yt:
            i = 10;
            break e;
          case Yt:
            i = 9;
            break e;
          case ct:
            i = 11;
            break e;
          case ft:
            i = 14;
            break e;
          case Ie:
            i = 16, r = null;
            break e;
        }
        throw Error(c(130, e == null ? e : typeof e, ""));
    }
    return t = tt(i, n, t, l), t.elementType = e, t.type = r, t.lanes = u, t;
  }
  function on(e, t, n, r) {
    return e = tt(7, e, r, t), e.lanes = n, e;
  }
  function _l(e, t, n, r) {
    return e = tt(22, e, r, t), e.elementType = fe, e.lanes = n, e.stateNode = { isHidden: !1 }, e;
  }
  function gi(e, t, n) {
    return e = tt(6, e, null, t), e.lanes = n, e;
  }
  function ki(e, t, n) {
    return t = tt(4, e.children !== null ? e.children : [], e.key, t), t.lanes = n, t.stateNode = { containerInfo: e.containerInfo, pendingChildren: null, implementation: e.implementation }, t;
  }
  function Tf(e, t, n, r, l) {
    this.tag = t, this.containerInfo = e, this.finishedWork = this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.pendingContext = this.context = null, this.callbackPriority = 0, this.eventTimes = Kl(0), this.expirationTimes = Kl(-1), this.entangledLanes = this.finishedLanes = this.mutableReadLanes = this.expiredLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = Kl(0), this.identifierPrefix = r, this.onRecoverableError = l, this.mutableSourceEagerHydrationData = null;
  }
  function wi(e, t, n, r, l, u, i, o, s) {
    return e = new Tf(e, t, n, o, s), t === 1 ? (t = 1, u === !0 && (t |= 8)) : t = 0, u = tt(3, null, null, t), e.current = u, u.stateNode = e, u.memoizedState = { element: r, isDehydrated: n, cache: null, transitions: null, pendingSuspenseBoundaries: null }, Mu(u), e;
  }
  function Rf(e, t, n) {
    var r = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return { $$typeof: je, key: r == null ? null : "" + r, children: e, containerInfo: t, implementation: n };
  }
  function Sa(e) {
    if (!e) return Dt;
    e = e._reactInternals;
    e: {
      if (Xt(e) !== e || e.tag !== 1) throw Error(c(170));
      var t = e;
      do {
        switch (t.tag) {
          case 3:
            t = t.stateNode.context;
            break e;
          case 1:
            if (Ue(t.type)) {
              t = t.stateNode.__reactInternalMemoizedMergedChildContext;
              break e;
            }
        }
        t = t.return;
      } while (t !== null);
      throw Error(c(171));
    }
    if (e.tag === 1) {
      var n = e.type;
      if (Ue(n)) return Go(e, n, t);
    }
    return t;
  }
  function _a(e, t, n, r, l, u, i, o, s) {
    return e = wi(n, r, !0, e, l, u, i, o, s), e.context = Sa(null), n = e.current, r = Oe(), l = Bt(n), u = xt(r, l), u.callback = t ?? null, Ut(n, u, l), e.current.lanes = l, Vn(e, l, r), $e(e, r), e;
  }
  function xl(e, t, n, r) {
    var l = t.current, u = Oe(), i = Bt(l);
    return n = Sa(n), t.context === null ? t.context = n : t.pendingContext = n, t = xt(u, i), t.payload = { element: e }, r = r === void 0 ? null : r, r !== null && (t.callback = r), e = Ut(l, t, i), e !== null && (at(e, l, i, u), el(e, l, i)), i;
  }
  function El(e) {
    if (e = e.current, !e.child) return null;
    switch (e.child.tag) {
      case 5:
        return e.child.stateNode;
      default:
        return e.child.stateNode;
    }
  }
  function xa(e, t) {
    if (e = e.memoizedState, e !== null && e.dehydrated !== null) {
      var n = e.retryLane;
      e.retryLane = n !== 0 && n < t ? n : t;
    }
  }
  function Si(e, t) {
    xa(e, t), (e = e.alternate) && xa(e, t);
  }
  function Lf() {
    return null;
  }
  var Ea = typeof reportError == "function" ? reportError : function(e) {
    console.error(e);
  };
  function _i(e) {
    this._internalRoot = e;
  }
  Cl.prototype.render = _i.prototype.render = function(e) {
    var t = this._internalRoot;
    if (t === null) throw Error(c(409));
    xl(e, t, null, null);
  }, Cl.prototype.unmount = _i.prototype.unmount = function() {
    var e = this._internalRoot;
    if (e !== null) {
      this._internalRoot = null;
      var t = e.containerInfo;
      rn(function() {
        xl(null, e, null, null);
      }), t[gt] = null;
    }
  };
  function Cl(e) {
    this._internalRoot = e;
  }
  Cl.prototype.unstable_scheduleHydration = function(e) {
    if (e) {
      var t = io();
      e = { blockedOn: null, target: e, priority: t };
      for (var n = 0; n < Rt.length && t !== 0 && t < Rt[n].priority; n++) ;
      Rt.splice(n, 0, e), n === 0 && ao(e);
    }
  };
  function xi(e) {
    return !(!e || e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11);
  }
  function Nl(e) {
    return !(!e || e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11 && (e.nodeType !== 8 || e.nodeValue !== " react-mount-point-unstable "));
  }
  function Ca() {
  }
  function jf(e, t, n, r, l) {
    if (l) {
      if (typeof r == "function") {
        var u = r;
        r = function() {
          var h = El(i);
          u.call(h);
        };
      }
      var i = _a(t, r, e, 0, null, !1, !1, "", Ca);
      return e._reactRootContainer = i, e[gt] = i.current, er(e.nodeType === 8 ? e.parentNode : e), rn(), i;
    }
    for (; l = e.lastChild; ) e.removeChild(l);
    if (typeof r == "function") {
      var o = r;
      r = function() {
        var h = El(s);
        o.call(h);
      };
    }
    var s = wi(e, 0, !1, null, null, !1, !1, "", Ca);
    return e._reactRootContainer = s, e[gt] = s.current, er(e.nodeType === 8 ? e.parentNode : e), rn(function() {
      xl(t, s, n, r);
    }), s;
  }
  function Pl(e, t, n, r, l) {
    var u = n._reactRootContainer;
    if (u) {
      var i = u;
      if (typeof l == "function") {
        var o = l;
        l = function() {
          var s = El(i);
          o.call(s);
        };
      }
      xl(t, i, e, l);
    } else i = jf(n, t, e, l, r);
    return El(i);
  }
  lo = function(e) {
    switch (e.tag) {
      case 3:
        var t = e.stateNode;
        if (t.current.memoizedState.isDehydrated) {
          var n = An(t.pendingLanes);
          n !== 0 && (Yl(t, n | 1), $e(t, he()), (K & 6) === 0 && (Ln = he() + 500, It()));
        }
        break;
      case 13:
        rn(function() {
          var r = _t(e, 1);
          if (r !== null) {
            var l = Oe();
            at(r, e, 1, l);
          }
        }), Si(e, 1);
    }
  }, Xl = function(e) {
    if (e.tag === 13) {
      var t = _t(e, 134217728);
      if (t !== null) {
        var n = Oe();
        at(t, e, 134217728, n);
      }
      Si(e, 134217728);
    }
  }, uo = function(e) {
    if (e.tag === 13) {
      var t = Bt(e), n = _t(e, t);
      if (n !== null) {
        var r = Oe();
        at(n, e, t, r);
      }
      Si(e, t);
    }
  }, io = function() {
    return b;
  }, oo = function(e, t) {
    var n = b;
    try {
      return b = e, t();
    } finally {
      b = n;
    }
  }, Vl = function(e, t, n) {
    switch (t) {
      case "input":
        if (jl(e, n), t = n.name, n.type === "radio" && t != null) {
          for (n = e; n.parentNode; ) n = n.parentNode;
          for (n = n.querySelectorAll("input[name=" + JSON.stringify("" + t) + '][type="radio"]'), t = 0; t < n.length; t++) {
            var r = n[t];
            if (r !== e && r.form === e.form) {
              var l = Wr(r);
              if (!l) throw Error(c(90));
              Li(r), jl(r, l);
            }
          }
        }
        break;
      case "textarea":
        Ii(e, n);
        break;
      case "select":
        t = n.value, t != null && sn(e, !!n.multiple, t, !1);
    }
  }, Qi = hi, Ki = rn;
  var Mf = { usingClientEntryPoint: !1, Events: [rr, gn, Wr, Hi, Wi, hi] }, yr = { findFiberByHostInstance: Gt, bundleType: 0, version: "18.3.1", rendererPackageName: "react-dom" }, Of = { bundleType: yr.bundleType, version: yr.version, rendererPackageName: yr.rendererPackageName, rendererConfig: yr.rendererConfig, overrideHookState: null, overrideHookStateDeletePath: null, overrideHookStateRenamePath: null, overrideProps: null, overridePropsDeletePath: null, overridePropsRenamePath: null, setErrorHandler: null, setSuspenseHandler: null, scheduleUpdate: null, currentDispatcherRef: ge.ReactCurrentDispatcher, findHostInstanceByFiber: function(e) {
    return e = Zi(e), e === null ? null : e.stateNode;
  }, findFiberByHostInstance: yr.findFiberByHostInstance || Lf, findHostInstancesForRefresh: null, scheduleRefresh: null, scheduleRoot: null, setRefreshHandler: null, getCurrentFiber: null, reconcilerVersion: "18.3.1-next-f1338f8080-20240426" };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var zl = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!zl.isDisabled && zl.supportsFiber) try {
      Cr = zl.inject(Of), dt = zl;
    } catch {
    }
  }
  return Be.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = Mf, Be.createPortal = function(e, t) {
    var n = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!xi(t)) throw Error(c(200));
    return Rf(e, t, null, n);
  }, Be.createRoot = function(e, t) {
    if (!xi(e)) throw Error(c(299));
    var n = !1, r = "", l = Ea;
    return t != null && (t.unstable_strictMode === !0 && (n = !0), t.identifierPrefix !== void 0 && (r = t.identifierPrefix), t.onRecoverableError !== void 0 && (l = t.onRecoverableError)), t = wi(e, 1, !1, null, null, n, !1, r, l), e[gt] = t.current, er(e.nodeType === 8 ? e.parentNode : e), new _i(t);
  }, Be.findDOMNode = function(e) {
    if (e == null) return null;
    if (e.nodeType === 1) return e;
    var t = e._reactInternals;
    if (t === void 0)
      throw typeof e.render == "function" ? Error(c(188)) : (e = Object.keys(e).join(","), Error(c(268, e)));
    return e = Zi(t), e = e === null ? null : e.stateNode, e;
  }, Be.flushSync = function(e) {
    return rn(e);
  }, Be.hydrate = function(e, t, n) {
    if (!Nl(t)) throw Error(c(200));
    return Pl(null, e, t, !0, n);
  }, Be.hydrateRoot = function(e, t, n) {
    if (!xi(e)) throw Error(c(405));
    var r = n != null && n.hydratedSources || null, l = !1, u = "", i = Ea;
    if (n != null && (n.unstable_strictMode === !0 && (l = !0), n.identifierPrefix !== void 0 && (u = n.identifierPrefix), n.onRecoverableError !== void 0 && (i = n.onRecoverableError)), t = _a(t, null, e, 1, n ?? null, l, !1, u, i), e[gt] = t.current, er(e), r) for (e = 0; e < r.length; e++) n = r[e], l = n._getVersion, l = l(n._source), t.mutableSourceEagerHydrationData == null ? t.mutableSourceEagerHydrationData = [n, l] : t.mutableSourceEagerHydrationData.push(
      n,
      l
    );
    return new Cl(t);
  }, Be.render = function(e, t, n) {
    if (!Nl(t)) throw Error(c(200));
    return Pl(null, e, t, !1, n);
  }, Be.unmountComponentAtNode = function(e) {
    if (!Nl(e)) throw Error(c(40));
    return e._reactRootContainer ? (rn(function() {
      Pl(null, null, e, !1, function() {
        e._reactRootContainer = null, e[gt] = null;
      });
    }), !0) : !1;
  }, Be.unstable_batchedUpdates = hi, Be.unstable_renderSubtreeIntoContainer = function(e, t, n, r) {
    if (!Nl(n)) throw Error(c(200));
    if (e == null || e._reactInternals === void 0) throw Error(c(38));
    return Pl(e, t, n, !1, r);
  }, Be.version = "18.3.1-next-f1338f8080-20240426", Be;
}
var Ma;
function Ia() {
  if (Ma) return Ni.exports;
  Ma = 1;
  function m() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(m);
      } catch (v) {
        console.error(v);
      }
  }
  return m(), Ni.exports = Wf(), Ni.exports;
}
var Oa;
function Qf() {
  if (Oa) return Rl;
  Oa = 1;
  var m = Ia();
  return Rl.createRoot = m.createRoot, Rl.hydrateRoot = m.hydrateRoot, Rl;
}
var Kf = Qf(), Kt = Ri();
const Yf = {
  approve: { text: "✓ 已同意", cls: "ok" },
  allow: { text: "★ 已始终允许", cls: "ok" },
  reject: { text: "✗ 已拒绝", cls: "fail" },
  edit: { text: "✎ 已编辑", cls: "edit" }
};
class Xf {
  constructor() {
    Tl(this, "subscribe", (v) => (this.listeners.add(v), () => this.listeners.delete(v)));
    Tl(this, "listeners", /* @__PURE__ */ new Set());
    Tl(this, "getSnapshot", () => this._snap);
    this.cards = [], this._snap = { cards: [] }, this._seq = 0, this._activeId = null, this._dirty = !1, this._timer = null, this._lastSummaryMd = null, this.onDecision = null, this.onRescue = null;
  }
  _emit() {
    this._snap = { cards: this.cards.slice() };
    for (const v of this.listeners) v();
  }
  _card(v) {
    return this.cards.find((c) => c.id === v) || null;
  }
  _active() {
    return this._activeId ? this._card(this._activeId) : null;
  }
  // 流式 token 100ms 批冲刷：token 事件可能高频到达，逐 token setState
  // 会渲染风暴；攒到定时器统一出快照。
  _flushSoon() {
    this._timer || (this._timer = setTimeout(() => {
      this._timer = null, this._dirty && (this._dirty = !1, this._emit());
    }, 100));
  }
  // 同步冲刷 token 缓冲（定格/结账场景用：冻结前把最后一批 flush 进卡，
  // 否则 _freezeActive 清 _dirty 会丢掉定时器里未出的尾批内容）
  flushNow() {
    this._timer && (clearTimeout(this._timer), this._timer = null), this._dirty && (this._dirty = !1, this._emit());
  }
  _freezeActive(v) {
    const c = this._active();
    return c && (c.done = !0, c.failed = !!v, this._activeId = null, this._dirty = !1), c;
  }
  // 决策入口（审批卡按钮与快捷键共用）：写回执徽标 + 通知 app.js 发 WS
  _decide(v, c) {
    const T = [...this.cards].reverse().find(
      (Y) => Y.type === "approval" && !Y.decided
    );
    if (!T) return !1;
    const U = Yf[v];
    if (!U) return !1;
    let H;
    if (v === "approve") H = { type: "approve" };
    else if (v === "allow") H = { type: "approve", allow: !0 };
    else if (v === "reject") H = { type: "reject", message: "用户拒绝了该命令" };
    else if (v === "edit")
      H = { type: "edit", edited_action: { name: "execute", args: { command: c } } }, T.command = c;
    else return !1;
    return T.decided = { text: U.text, cls: U.cls }, T.editorOpen = !1, this._emit(), this.onDecision && this.onDecision(H, U.text, T.command, T.id), !0;
  }
  handle(v) {
    switch (v.kind) {
      case "task_start": {
        const c = {
          id: v.id || ++this._seq,
          type: "analysis",
          think: !0,
          text: "",
          reason: "",
          done: !1,
          failed: !1
        };
        this.cards.push(c), this._activeId = c.id, this._lastSummaryMd = null, this._emit();
        break;
      }
      case "ai_token": {
        const c = this._active();
        if (!c || c.done) return;
        c.think && (c.think = !1), c.text += v.text, this._dirty = !0, this._flushSoon();
        break;
      }
      // 模型思考过程流式入卡（灰字），让任务全程的中间过程可见——
      // 工具调用阶段模型往往只有 thinking 没有正文，不收思考块分析卡
      // 会一直空转「正在思考」
      case "ai_think": {
        const c = this._active();
        if (!c || c.done) return;
        c.think && (c.think = !1), c.reason += v.text, this._dirty = !0, this._flushSoon();
        break;
      }
      case "ai_collapse": {
        if (v.trimMd) {
          this.flushNow();
          const c = this._active();
          if (c && !c.done) {
            const T = (c.text || "").trimEnd(), U = v.trimMd.trim();
            U && T.endsWith(U) && (c.text = T.slice(0, T.length - U.length).trimEnd(), this._dirty = !0);
          }
        }
        this._freezeActive(!1), this._emit();
        break;
      }
      case "ai_card":
        this._applySummary(v.md, v.id);
        break;
      case "final":
        {
          const c = this._active();
          v.md && c && !c.done && this._applySummary(v.md);
        }
        this._freezeActive(!1), this._emit();
        break;
      case "task_fail":
        this._freezeActive(!0), this._emit();
        break;
      case "approval": {
        const c = {
          id: v.id || ++this._seq,
          type: "approval",
          command: v.command || "",
          reasons: v.reasons || "",
          risk: v.risk || "high",
          decided: null,
          editorOpen: !1
        };
        this.cards.push(c), this._emit();
        break;
      }
      case "decide":
        this._decide(v.decision, v.edited);
        break;
      case "rescue": {
        const c = {
          id: v.id || ++this._seq,
          type: "rescue",
          line: v.line || "",
          ec: v.ec != null ? v.ec : "?",
          output: v.output || "",
          decided: null
        };
        this.cards.push(c), this._emit();
        break;
      }
      case "rescue_decide": {
        const c = [...this.cards].reverse().find(
          (T) => T.type === "rescue" && !T.decided
        );
        return c ? (c.decided = v.accept ? { text: "✓ 已交给 AI", cls: "ok" } : { text: "已忽略", cls: "fail" }, this._emit(), this.onRescue && this.onRescue(!!v.accept), !0) : !1;
      }
      case "approval_key": {
        const c = [...this.cards].reverse().find(
          (T) => T.type === "approval" && !T.decided
        );
        return c ? v.key === "Enter" ? this._decide("approve") : v.key === "e" || v.key === "E" ? (c.editorOpen = !c.editorOpen, this._emit(), !0) : v.key === "Backspace" ? this._decide("reject") : !1 : !1;
      }
      case "clear":
        this.cards = [], this._activeId = null, this._dirty = !1, this._emit();
        break;
    }
  }
  // 换装：流式分析卡原地变为总结卡（同 id 不重挂）。
  // 去重：worker 会连发 ai_card(md) 与 final(md)（同一份 markdown），
  // 第二次直接跳过，避免同文双卡。
  _applySummary(v, c) {
    if (!v || v === this._lastSummaryMd) return;
    this._lastSummaryMd = v;
    const T = this._active();
    T ? (T.type = "summary", T.text = v, T.done = !0, T.failed = !1, this._activeId = null) : this.cards.push({
      id: c ?? ++this._seq,
      type: "summary",
      text: v,
      done: !0,
      failed: !1
    }), this._emit();
  }
}
var Gf = Ia(), Ti = { exports: {} }, Da;
function Zf() {
  return Da || (Da = 1, (function(m) {
    function v(O) {
      return String(O ?? "").replace(/[&<>"']/g, (C) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[C]);
    }
    function c(O) {
      return O.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }
    function T(O) {
      const C = [];
      let W = "";
      for (let te = 0; te < O.length; te++) {
        const V = O[te];
        if (V === "\\" && O[te + 1] === "|") {
          W += "|", te++;
          continue;
        }
        if (V === "|") {
          C.push(W.trim()), W = "";
          continue;
        }
        W += V;
      }
      return C.push(W.trim()), C.length && C[0] === "" && C.shift(), C.length && C[C.length - 1] === "" && C.pop(), C;
    }
    function U(O) {
      const C = O.map(T), W = C[1].map((F) => /^:-+:$/.test(F) ? "center" : /-+:$/.test(F) ? "right" : "left"), te = (F) => W[F] && W[F] !== "left" ? ` class="a-${W[F]}"` : "", V = (F, pe) => "<tr>" + F.map((Ne, ye) => `<${pe}${te(ye)}>` + c(Ne) + `</${pe}>`).join("") + "</tr>";
      return '<div class="mtable"><table><thead>' + V(C[0], "th") + "</thead><tbody>" + C.slice(2).map((F) => V(F, "td")).join("") + "</tbody></table></div>";
    }
    const H = (O) => /^\s*\|.*\|\s*$/.test(O);
    function Y(O) {
      let C = String(O ?? "");
      return (C.match(/`/g) || []).length % 2 && (C = C.slice(0, C.lastIndexOf("`"))), (C.match(/\*\*/g) || []).length % 2 && (C = C.slice(0, C.lastIndexOf("**"))), C;
    }
    const ee = new RegExp("^\\p{Extended_Pictographic}", "u"), Q = /[。！？；：,.;:）)】\]」"']$/;
    function J(O) {
      const C = O.trim();
      return !C || C.includes("|") || !ee.test(C) || Q.test(C) ? !1 : [...C].length <= 24;
    }
    function se(O) {
      const C = v(String(O ?? "")).split(`
`), W = [];
      let te = null;
      const V = () => {
        te && (W.push("</" + te + ">"), te = null);
      };
      for (let F = 0; F < C.length; F++) {
        const pe = C[F];
        if (H(pe) && F + 1 < C.length && /^\s*\|[\s:|-]+\|\s*$/.test(C[F + 1])) {
          V();
          const ge = [];
          let Pe = F;
          for (; Pe < C.length && H(C[Pe]); ) ge.push(C[Pe++]);
          W.push(U(ge)), F = Pe - 1;
          continue;
        }
        const Ne = pe.match(/^\s*(#{1,4})\s+(.+)$/);
        if (Ne) {
          V(), W.push('<div class="mh mh' + Ne[1].length + '">' + c(Ne[2]) + "</div>");
          continue;
        }
        let ye = pe.match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (ye) {
          te !== "ol" && (V(), W.push("<ol>"), te = "ol"), W.push("<li>" + c(ye[2]) + "</li>");
          continue;
        }
        if (ye = pe.match(/^\s*[-*]\s+(.*)$/), ye) {
          te !== "ul" && (V(), W.push("<ul>"), te = "ul"), W.push("<li>" + c(ye[1]) + "</li>");
          continue;
        }
        if (V(), !pe.trim()) {
          W.push('<div class="mgap"></div>');
          continue;
        }
        if (J(pe)) {
          W.push('<div class="mh mh2">' + c(pe.trim()) + "</div>");
          continue;
        }
        W.push('<div class="mline">' + c(pe) + "</div>");
      }
      return V(), W.join("");
    }
    m.exports && (m.exports = {
      esc: v,
      mdInline: c,
      mdLite: se,
      stripIncompleteMarkers: Y,
      isBareSectionTitle: J,
      _splitRow: T,
      _renderTable: U,
      isPipeRow: H
    });
  })(Ti)), Ti.exports;
}
var Jf = Zf();
const qf = /* @__PURE__ */ Uf(Jf), { mdLite: Fa, stripIncompleteMarkers: bf } = qf;
function ed({ card: m, dispatch: v }) {
  return m ? /* @__PURE__ */ L.jsx(td, { card: m, dispatch: v }) : null;
}
function td({ card: m, dispatch: v }) {
  switch (m.type) {
    case "analysis":
      return /* @__PURE__ */ L.jsx(nd, { card: m, dispatch: v });
    case "summary":
      return /* @__PURE__ */ L.jsx(rd, { card: m, dispatch: v });
    case "approval":
      return /* @__PURE__ */ L.jsx(ld, { card: m, dispatch: v });
    case "rescue":
      return /* @__PURE__ */ L.jsx(ud, { card: m, dispatch: v });
    default:
      return null;
  }
}
function Ua({ card: m, label: v }) {
  return /* @__PURE__ */ L.jsxs("div", { className: "ahead", children: [
    /* @__PURE__ */ L.jsx("span", { className: "adot" }),
    /* @__PURE__ */ L.jsx("span", { className: "alabel", children: v })
  ] });
}
function nd({ card: m, dispatch: v }) {
  const c = m.failed ? "分析 · 已中止" : "分析", T = m.think && !m.done, U = T ? null : { __html: Fa(bf(m.text)) };
  return /* @__PURE__ */ L.jsxs("div", { className: "ablock" + (m.done ? " done" : "") + (T ? " think" : "") + (m.failed ? " failed" : ""), children: [
    /* @__PURE__ */ L.jsx(Ua, { card: m, label: c }),
    T ? /* @__PURE__ */ L.jsx("div", { className: "atext think", children: "AI 正在思考..." }) : m.think && !m.reason ? /* @__PURE__ */ L.jsx("div", { className: "atext", children: "（本次任务无分析输出）" }) : /* @__PURE__ */ L.jsxs("div", { className: "atext", children: [
      m.reason ? /* @__PURE__ */ L.jsx("div", { className: "areason", children: m.reason }) : null,
      m.text ? /* @__PURE__ */ L.jsx("div", { dangerouslySetInnerHTML: U }) : null
    ] })
  ] });
}
function rd({ card: m, dispatch: v }) {
  const c = { __html: Fa(m.text) };
  return /* @__PURE__ */ L.jsxs("div", { className: "scard", children: [
    /* @__PURE__ */ L.jsx(Ua, { card: m, label: "总结" }),
    /* @__PURE__ */ L.jsx("div", { className: "sbody", dangerouslySetInnerHTML: c })
  ] });
}
function ld({ card: m, dispatch: v }) {
  const c = m.risk === "high", T = Kt.useRef(null), [U, H] = Kt.useState(!1), Y = () => H(!1), ee = (J, se) => v({ kind: "decide", decision: J, edited: se }), Q = () => c ? H((J) => !J) : ee("approve");
  return /* @__PURE__ */ L.jsxs("div", { className: "acard aprobe" + (c ? " high" : "") + (m.editorOpen ? " edopen" : ""), children: [
    /* @__PURE__ */ L.jsxs("div", { className: "aphead", children: [
      m.decided ? /* @__PURE__ */ L.jsx("span", { className: "apstate " + m.decided.cls, children: m.decided.text }) : /* @__PURE__ */ L.jsx("span", { className: "apq", children: c ? "是否同意执行以下高危命令并查看输出？" : "是否同意执行以下命令并查看输出？" }),
      !m.decided && /* @__PURE__ */ L.jsxs("span", { className: "apbtns", children: [
        /* @__PURE__ */ L.jsxs("span", { className: "apexec", children: [
          /* @__PURE__ */ L.jsxs("button", { className: "primary", onClick: Q, children: [
            "执行 ",
            /* @__PURE__ */ L.jsx("kbd", { children: "Ctrl ↵" })
          ] }),
          U && /* @__PURE__ */ L.jsxs("span", { className: "apconfirm", children: [
            /* @__PURE__ */ L.jsx("span", { className: "apconfirm-q", children: "高危命令，确认执行？" }),
            /* @__PURE__ */ L.jsx("button", { className: "primary", onClick: () => ee("approve"), children: "确认执行" }),
            /* @__PURE__ */ L.jsx("button", { onClick: Y, children: "取消" })
          ] })
        ] }),
        /* @__PURE__ */ L.jsxs("button", { onClick: () => {
          Y(), v({ kind: "approval_key", key: "e" });
        }, children: [
          "修改 ",
          /* @__PURE__ */ L.jsx("kbd", { children: "Ctrl E" })
        ] }),
        /* @__PURE__ */ L.jsxs("button", { onClick: () => {
          Y(), ee("reject");
        }, children: [
          "拒绝 ",
          /* @__PURE__ */ L.jsx("kbd", { children: "Ctrl ⌫" })
        ] }),
        /* @__PURE__ */ L.jsx("button", { className: "ghost", onClick: () => {
          Y(), ee("allow");
        }, children: "始终允许" })
      ] })
    ] }),
    /* @__PURE__ */ L.jsx("pre", { className: "apcode" + (m.decided && m.decided.cls === "ok" ? " locked" : ""), children: m.command }),
    m.reasons ? /* @__PURE__ */ L.jsx("div", { className: "apreasons", children: m.reasons }) : null,
    m.editorOpen && !m.decided && /* @__PURE__ */ L.jsx(id, { card: m, taRef: T, dispatch: v })
  ] });
}
function ud({ card: m, dispatch: v }) {
  return /* @__PURE__ */ L.jsxs("div", { className: "acard aprobe", children: [
    /* @__PURE__ */ L.jsxs("div", { className: "aphead", children: [
      m.decided ? /* @__PURE__ */ L.jsx("span", { className: "apstate " + m.decided.cls, children: m.decided.text }) : /* @__PURE__ */ L.jsxs("span", { className: "apq", children: [
        "这行执行失败了（exit ",
        m.ec,
        "），交给 AI 处理？"
      ] }),
      !m.decided && /* @__PURE__ */ L.jsxs("span", { className: "apbtns", children: [
        /* @__PURE__ */ L.jsx(
          "button",
          {
            className: "primary",
            onClick: () => v({ kind: "rescue_decide", accept: !0 }),
            children: "交给 AI"
          }
        ),
        /* @__PURE__ */ L.jsx("button", { onClick: () => v({ kind: "rescue_decide", accept: !1 }), children: "忽略" })
      ] })
    ] }),
    /* @__PURE__ */ L.jsx("pre", { className: "apcode", children: m.line }),
    m.output ? /* @__PURE__ */ L.jsx("div", { className: "apreasons", children: m.output }) : null
  ] });
}
function id({ card: m, taRef: v, dispatch: c }) {
  const [T, U] = Kt.useState(m.command), H = Kt.useRef(null), [Y, ee] = Kt.useState(null);
  Kt.useEffect(() => {
    ee(H.current && H.current.closest(".pane"));
  }, []), Kt.useEffect(() => {
    if (!Y) return;
    let J = 0;
    const se = () => {
      const O = v.current;
      if (O) {
        if (O.focus(), document.activeElement === O) {
          O.select();
          return;
        }
        J++ < 8 && setTimeout(se, 60);
      }
    };
    se();
  }, [Y]);
  const Q = () => {
    const J = T.trim();
    J && c({ kind: "decide", decision: "edit", edited: J });
  };
  return /* @__PURE__ */ L.jsxs(L.Fragment, { children: [
    /* @__PURE__ */ L.jsx("span", { ref: H, hidden: !0 }),
    Y ? Gf.createPortal(
      /* @__PURE__ */ L.jsxs("div", { className: "apedit", children: [
        /* @__PURE__ */ L.jsx(
          "textarea",
          {
            ref: v,
            rows: "2",
            spellCheck: "false",
            autoFocus: !0,
            value: T,
            onChange: (J) => U(J.target.value)
          }
        ),
        /* @__PURE__ */ L.jsxs("div", { className: "apedit-btns", children: [
          /* @__PURE__ */ L.jsx("button", { className: "primary", onClick: Q, children: "保存并执行" }),
          /* @__PURE__ */ L.jsx("button", { onClick: () => c({ kind: "approval_key", key: "e" }), children: "取消" })
        ] })
      ] }),
      Y
    ) : null
  ] });
}
function od({ store: m, cardId: v }) {
  const T = Kt.useSyncExternalStore(m.subscribe, m.getSnapshot).cards.find((U) => U.id === v) || null;
  return /* @__PURE__ */ L.jsx(ed, { card: T, dispatch: (U) => m.handle(U) });
}
function ad(m) {
  const v = new Xf();
  m && m.onDecision && (v.onDecision = m.onDecision), m && m.onRescue && (v.onRescue = m.onRescue);
  const c = /* @__PURE__ */ new Map();
  return {
    handle: (T) => v.handle(T),
    flush: () => v.flushNow(),
    mount(T, U) {
      const H = c.get(T);
      if (H) {
        if (H.el === U) return;
        c.delete(T);
        try {
          H.root.unmount();
        } catch {
        }
      }
      const Y = Kf.createRoot(U);
      Y.render(/* @__PURE__ */ L.jsx(od, { store: v, cardId: T })), c.set(T, { root: Y, el: U });
    },
    unmount(T) {
      const U = c.get(T);
      if (U) {
        c.delete(T);
        try {
          U.root.unmount();
        } catch {
        }
      }
    },
    destroy() {
      for (const T of [...c.keys()]) this.unmount(T);
    }
  };
}
export {
  ad as createFeed
};
