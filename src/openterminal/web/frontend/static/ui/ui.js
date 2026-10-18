var If = Object.defineProperty;
var Ff = (f, p, s) => p in f ? If(f, p, { enumerable: !0, configurable: !0, writable: !0, value: s }) : f[p] = s;
var jl = (f, p, s) => Ff(f, typeof p != "symbol" ? p + "" : p, s);
function Uf(f) {
  return f && f.__esModule && Object.prototype.hasOwnProperty.call(f, "default") ? f.default : f;
}
var Eu = { exports: {} }, gr = {}, Cu = { exports: {} }, W = {};
/**
 * @license React
 * react.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Pa;
function Af() {
  if (Pa) return W;
  Pa = 1;
  var f = Symbol.for("react.element"), p = Symbol.for("react.portal"), s = Symbol.for("react.fragment"), _ = Symbol.for("react.strict_mode"), x = Symbol.for("react.profiler"), I = Symbol.for("react.provider"), V = Symbol.for("react.context"), Y = Symbol.for("react.forward_ref"), H = Symbol.for("react.suspense"), b = Symbol.for("react.memo"), oe = Symbol.for("react.lazy"), X = Symbol.iterator;
  function D(d) {
    return d === null || typeof d != "object" ? null : (d = X && d[X] || d["@@iterator"], typeof d == "function" ? d : null);
  }
  var L = { isMounted: function() {
    return !1;
  }, enqueueForceUpdate: function() {
  }, enqueueReplaceState: function() {
  }, enqueueSetState: function() {
  } }, K = Object.assign, A = {};
  function $(d, g, B) {
    this.props = d, this.context = g, this.refs = A, this.updater = B || L;
  }
  $.prototype.isReactComponent = {}, $.prototype.setState = function(d, g) {
    if (typeof d != "object" && typeof d != "function" && d != null) throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");
    this.updater.enqueueSetState(this, d, g, "setState");
  }, $.prototype.forceUpdate = function(d) {
    this.updater.enqueueForceUpdate(this, d, "forceUpdate");
  };
  function ne() {
  }
  ne.prototype = $.prototype;
  function ve(d, g, B) {
    this.props = d, this.context = g, this.refs = A, this.updater = B || L;
  }
  var de = ve.prototype = new ne();
  de.constructor = ve, K(de, $.prototype), de.isPureReactComponent = !0;
  var pe = Array.isArray, Pe = Object.prototype.hasOwnProperty, xe = { current: null }, ke = { key: !0, ref: !0, __self: !0, __source: !0 };
  function Ge(d, g, B) {
    var Q, Z = {}, J = null, re = null;
    if (g != null) for (Q in g.ref !== void 0 && (re = g.ref), g.key !== void 0 && (J = "" + g.key), g) Pe.call(g, Q) && !ke.hasOwnProperty(Q) && (Z[Q] = g[Q]);
    var ee = arguments.length - 2;
    if (ee === 1) Z.children = B;
    else if (1 < ee) {
      for (var se = Array(ee), We = 0; We < ee; We++) se[We] = arguments[We + 2];
      Z.children = se;
    }
    if (d && d.defaultProps) for (Q in ee = d.defaultProps, ee) Z[Q] === void 0 && (Z[Q] = ee[Q]);
    return { $$typeof: f, type: d, key: J, ref: re, props: Z, _owner: xe.current };
  }
  function Pt(d, g) {
    return { $$typeof: f, type: d.type, key: g, ref: d.ref, props: d.props, _owner: d._owner };
  }
  function gt(d) {
    return typeof d == "object" && d !== null && d.$$typeof === f;
  }
  function Yt(d) {
    var g = { "=": "=0", ":": "=2" };
    return "$" + d.replace(/[=:]/g, function(B) {
      return g[B];
    });
  }
  var ct = /\/+/g;
  function He(d, g) {
    return typeof d == "object" && d !== null && d.key != null ? Yt("" + d.key) : g.toString(36);
  }
  function nt(d, g, B, Q, Z) {
    var J = typeof d;
    (J === "undefined" || J === "boolean") && (d = null);
    var re = !1;
    if (d === null) re = !0;
    else switch (J) {
      case "string":
      case "number":
        re = !0;
        break;
      case "object":
        switch (d.$$typeof) {
          case f:
          case p:
            re = !0;
        }
    }
    if (re) return re = d, Z = Z(re), d = Q === "" ? "." + He(re, 0) : Q, pe(Z) ? (B = "", d != null && (B = d.replace(ct, "$&/") + "/"), nt(Z, g, B, "", function(We) {
      return We;
    })) : Z != null && (gt(Z) && (Z = Pt(Z, B + (!Z.key || re && re.key === Z.key ? "" : ("" + Z.key).replace(ct, "$&/") + "/") + d)), g.push(Z)), 1;
    if (re = 0, Q = Q === "" ? "." : Q + ":", pe(d)) for (var ee = 0; ee < d.length; ee++) {
      J = d[ee];
      var se = Q + He(J, ee);
      re += nt(J, g, B, se, Z);
    }
    else if (se = D(d), typeof se == "function") for (d = se.call(d), ee = 0; !(J = d.next()).done; ) J = J.value, se = Q + He(J, ee++), re += nt(J, g, B, se, Z);
    else if (J === "object") throw g = String(d), Error("Objects are not valid as a React child (found: " + (g === "[object Object]" ? "object with keys {" + Object.keys(d).join(", ") + "}" : g) + "). If you meant to render a collection of children, use an array instead.");
    return re;
  }
  function ft(d, g, B) {
    if (d == null) return d;
    var Q = [], Z = 0;
    return nt(d, Q, "", "", function(J) {
      return g.call(B, J, Z++);
    }), Q;
  }
  function Ie(d) {
    if (d._status === -1) {
      var g = d._result;
      g = g(), g.then(function(B) {
        (d._status === 0 || d._status === -1) && (d._status = 1, d._result = B);
      }, function(B) {
        (d._status === 0 || d._status === -1) && (d._status = 2, d._result = B);
      }), d._status === -1 && (d._status = 0, d._result = g);
    }
    if (d._status === 1) return d._result.default;
    throw d._result;
  }
  var me = { current: null }, C = { transition: null }, F = { ReactCurrentDispatcher: me, ReactCurrentBatchConfig: C, ReactCurrentOwner: xe };
  function z() {
    throw Error("act(...) is not supported in production builds of React.");
  }
  return W.Children = { map: ft, forEach: function(d, g, B) {
    ft(d, function() {
      g.apply(this, arguments);
    }, B);
  }, count: function(d) {
    var g = 0;
    return ft(d, function() {
      g++;
    }), g;
  }, toArray: function(d) {
    return ft(d, function(g) {
      return g;
    }) || [];
  }, only: function(d) {
    if (!gt(d)) throw Error("React.Children.only expected to receive a single React element child.");
    return d;
  } }, W.Component = $, W.Fragment = s, W.Profiler = x, W.PureComponent = ve, W.StrictMode = _, W.Suspense = H, W.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = F, W.act = z, W.cloneElement = function(d, g, B) {
    if (d == null) throw Error("React.cloneElement(...): The argument must be a React element, but you passed " + d + ".");
    var Q = K({}, d.props), Z = d.key, J = d.ref, re = d._owner;
    if (g != null) {
      if (g.ref !== void 0 && (J = g.ref, re = xe.current), g.key !== void 0 && (Z = "" + g.key), d.type && d.type.defaultProps) var ee = d.type.defaultProps;
      for (se in g) Pe.call(g, se) && !ke.hasOwnProperty(se) && (Q[se] = g[se] === void 0 && ee !== void 0 ? ee[se] : g[se]);
    }
    var se = arguments.length - 2;
    if (se === 1) Q.children = B;
    else if (1 < se) {
      ee = Array(se);
      for (var We = 0; We < se; We++) ee[We] = arguments[We + 2];
      Q.children = ee;
    }
    return { $$typeof: f, type: d.type, key: Z, ref: J, props: Q, _owner: re };
  }, W.createContext = function(d) {
    return d = { $$typeof: V, _currentValue: d, _currentValue2: d, _threadCount: 0, Provider: null, Consumer: null, _defaultValue: null, _globalName: null }, d.Provider = { $$typeof: I, _context: d }, d.Consumer = d;
  }, W.createElement = Ge, W.createFactory = function(d) {
    var g = Ge.bind(null, d);
    return g.type = d, g;
  }, W.createRef = function() {
    return { current: null };
  }, W.forwardRef = function(d) {
    return { $$typeof: Y, render: d };
  }, W.isValidElement = gt, W.lazy = function(d) {
    return { $$typeof: oe, _payload: { _status: -1, _result: d }, _init: Ie };
  }, W.memo = function(d, g) {
    return { $$typeof: b, type: d, compare: g === void 0 ? null : g };
  }, W.startTransition = function(d) {
    var g = C.transition;
    C.transition = {};
    try {
      d();
    } finally {
      C.transition = g;
    }
  }, W.unstable_act = z, W.useCallback = function(d, g) {
    return me.current.useCallback(d, g);
  }, W.useContext = function(d) {
    return me.current.useContext(d);
  }, W.useDebugValue = function() {
  }, W.useDeferredValue = function(d) {
    return me.current.useDeferredValue(d);
  }, W.useEffect = function(d, g) {
    return me.current.useEffect(d, g);
  }, W.useId = function() {
    return me.current.useId();
  }, W.useImperativeHandle = function(d, g, B) {
    return me.current.useImperativeHandle(d, g, B);
  }, W.useInsertionEffect = function(d, g) {
    return me.current.useInsertionEffect(d, g);
  }, W.useLayoutEffect = function(d, g) {
    return me.current.useLayoutEffect(d, g);
  }, W.useMemo = function(d, g) {
    return me.current.useMemo(d, g);
  }, W.useReducer = function(d, g, B) {
    return me.current.useReducer(d, g, B);
  }, W.useRef = function(d) {
    return me.current.useRef(d);
  }, W.useState = function(d) {
    return me.current.useState(d);
  }, W.useSyncExternalStore = function(d, g, B) {
    return me.current.useSyncExternalStore(d, g, B);
  }, W.useTransition = function() {
    return me.current.useTransition();
  }, W.version = "18.3.1", W;
}
var za;
function Ru() {
  return za || (za = 1, Cu.exports = Af()), Cu.exports;
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
var ja;
function $f() {
  if (ja) return gr;
  ja = 1;
  var f = Ru(), p = Symbol.for("react.element"), s = Symbol.for("react.fragment"), _ = Object.prototype.hasOwnProperty, x = f.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner, I = { key: !0, ref: !0, __self: !0, __source: !0 };
  function V(Y, H, b) {
    var oe, X = {}, D = null, L = null;
    b !== void 0 && (D = "" + b), H.key !== void 0 && (D = "" + H.key), H.ref !== void 0 && (L = H.ref);
    for (oe in H) _.call(H, oe) && !I.hasOwnProperty(oe) && (X[oe] = H[oe]);
    if (Y && Y.defaultProps) for (oe in H = Y.defaultProps, H) X[oe] === void 0 && (X[oe] = H[oe]);
    return { $$typeof: p, type: Y, key: D, ref: L, props: X, _owner: x.current };
  }
  return gr.Fragment = s, gr.jsx = V, gr.jsxs = V, gr;
}
var Ta;
function Vf() {
  return Ta || (Ta = 1, Eu.exports = $f()), Eu.exports;
}
var E = Vf(), Tl = {}, Nu = { exports: {} }, Be = {}, Pu = { exports: {} }, zu = {};
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
  return Ra || (Ra = 1, (function(f) {
    function p(C, F) {
      var z = C.length;
      C.push(F);
      e: for (; 0 < z; ) {
        var d = z - 1 >>> 1, g = C[d];
        if (0 < x(g, F)) C[d] = F, C[z] = g, z = d;
        else break e;
      }
    }
    function s(C) {
      return C.length === 0 ? null : C[0];
    }
    function _(C) {
      if (C.length === 0) return null;
      var F = C[0], z = C.pop();
      if (z !== F) {
        C[0] = z;
        e: for (var d = 0, g = C.length, B = g >>> 1; d < B; ) {
          var Q = 2 * (d + 1) - 1, Z = C[Q], J = Q + 1, re = C[J];
          if (0 > x(Z, z)) J < g && 0 > x(re, Z) ? (C[d] = re, C[J] = z, d = J) : (C[d] = Z, C[Q] = z, d = Q);
          else if (J < g && 0 > x(re, z)) C[d] = re, C[J] = z, d = J;
          else break e;
        }
      }
      return F;
    }
    function x(C, F) {
      var z = C.sortIndex - F.sortIndex;
      return z !== 0 ? z : C.id - F.id;
    }
    if (typeof performance == "object" && typeof performance.now == "function") {
      var I = performance;
      f.unstable_now = function() {
        return I.now();
      };
    } else {
      var V = Date, Y = V.now();
      f.unstable_now = function() {
        return V.now() - Y;
      };
    }
    var H = [], b = [], oe = 1, X = null, D = 3, L = !1, K = !1, A = !1, $ = typeof setTimeout == "function" ? setTimeout : null, ne = typeof clearTimeout == "function" ? clearTimeout : null, ve = typeof setImmediate < "u" ? setImmediate : null;
    typeof navigator < "u" && navigator.scheduling !== void 0 && navigator.scheduling.isInputPending !== void 0 && navigator.scheduling.isInputPending.bind(navigator.scheduling);
    function de(C) {
      for (var F = s(b); F !== null; ) {
        if (F.callback === null) _(b);
        else if (F.startTime <= C) _(b), F.sortIndex = F.expirationTime, p(H, F);
        else break;
        F = s(b);
      }
    }
    function pe(C) {
      if (A = !1, de(C), !K) if (s(H) !== null) K = !0, Ie(Pe);
      else {
        var F = s(b);
        F !== null && me(pe, F.startTime - C);
      }
    }
    function Pe(C, F) {
      K = !1, A && (A = !1, ne(Ge), Ge = -1), L = !0;
      var z = D;
      try {
        for (de(F), X = s(H); X !== null && (!(X.expirationTime > F) || C && !Yt()); ) {
          var d = X.callback;
          if (typeof d == "function") {
            X.callback = null, D = X.priorityLevel;
            var g = d(X.expirationTime <= F);
            F = f.unstable_now(), typeof g == "function" ? X.callback = g : X === s(H) && _(H), de(F);
          } else _(H);
          X = s(H);
        }
        if (X !== null) var B = !0;
        else {
          var Q = s(b);
          Q !== null && me(pe, Q.startTime - F), B = !1;
        }
        return B;
      } finally {
        X = null, D = z, L = !1;
      }
    }
    var xe = !1, ke = null, Ge = -1, Pt = 5, gt = -1;
    function Yt() {
      return !(f.unstable_now() - gt < Pt);
    }
    function ct() {
      if (ke !== null) {
        var C = f.unstable_now();
        gt = C;
        var F = !0;
        try {
          F = ke(!0, C);
        } finally {
          F ? He() : (xe = !1, ke = null);
        }
      } else xe = !1;
    }
    var He;
    if (typeof ve == "function") He = function() {
      ve(ct);
    };
    else if (typeof MessageChannel < "u") {
      var nt = new MessageChannel(), ft = nt.port2;
      nt.port1.onmessage = ct, He = function() {
        ft.postMessage(null);
      };
    } else He = function() {
      $(ct, 0);
    };
    function Ie(C) {
      ke = C, xe || (xe = !0, He());
    }
    function me(C, F) {
      Ge = $(function() {
        C(f.unstable_now());
      }, F);
    }
    f.unstable_IdlePriority = 5, f.unstable_ImmediatePriority = 1, f.unstable_LowPriority = 4, f.unstable_NormalPriority = 3, f.unstable_Profiling = null, f.unstable_UserBlockingPriority = 2, f.unstable_cancelCallback = function(C) {
      C.callback = null;
    }, f.unstable_continueExecution = function() {
      K || L || (K = !0, Ie(Pe));
    }, f.unstable_forceFrameRate = function(C) {
      0 > C || 125 < C ? console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported") : Pt = 0 < C ? Math.floor(1e3 / C) : 5;
    }, f.unstable_getCurrentPriorityLevel = function() {
      return D;
    }, f.unstable_getFirstCallbackNode = function() {
      return s(H);
    }, f.unstable_next = function(C) {
      switch (D) {
        case 1:
        case 2:
        case 3:
          var F = 3;
          break;
        default:
          F = D;
      }
      var z = D;
      D = F;
      try {
        return C();
      } finally {
        D = z;
      }
    }, f.unstable_pauseExecution = function() {
    }, f.unstable_requestPaint = function() {
    }, f.unstable_runWithPriority = function(C, F) {
      switch (C) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
          break;
        default:
          C = 3;
      }
      var z = D;
      D = C;
      try {
        return F();
      } finally {
        D = z;
      }
    }, f.unstable_scheduleCallback = function(C, F, z) {
      var d = f.unstable_now();
      switch (typeof z == "object" && z !== null ? (z = z.delay, z = typeof z == "number" && 0 < z ? d + z : d) : z = d, C) {
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
      return g = z + g, C = { id: oe++, callback: F, priorityLevel: C, startTime: z, expirationTime: g, sortIndex: -1 }, z > d ? (C.sortIndex = z, p(b, C), s(H) === null && C === s(b) && (A ? (ne(Ge), Ge = -1) : A = !0, me(pe, z - d))) : (C.sortIndex = g, p(H, C), K || L || (K = !0, Ie(Pe))), C;
    }, f.unstable_shouldYield = Yt, f.unstable_wrapCallback = function(C) {
      var F = D;
      return function() {
        var z = D;
        D = F;
        try {
          return C.apply(this, arguments);
        } finally {
          D = z;
        }
      };
    };
  })(zu)), zu;
}
var La;
function Hf() {
  return La || (La = 1, Pu.exports = Bf()), Pu.exports;
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
var Da;
function Wf() {
  if (Da) return Be;
  Da = 1;
  var f = Ru(), p = Hf();
  function s(e) {
    for (var t = "https://reactjs.org/docs/error-decoder.html?invariant=" + e, n = 1; n < arguments.length; n++) t += "&args[]=" + encodeURIComponent(arguments[n]);
    return "Minified React error #" + e + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  var _ = /* @__PURE__ */ new Set(), x = {};
  function I(e, t) {
    V(e, t), V(e + "Capture", t);
  }
  function V(e, t) {
    for (x[e] = t, e = 0; e < t.length; e++) _.add(t[e]);
  }
  var Y = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), H = Object.prototype.hasOwnProperty, b = /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/, oe = {}, X = {};
  function D(e) {
    return H.call(X, e) ? !0 : H.call(oe, e) ? !1 : b.test(e) ? X[e] = !0 : (oe[e] = !0, !1);
  }
  function L(e, t, n, r) {
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
  function K(e, t, n, r) {
    if (t === null || typeof t > "u" || L(e, t, n, r)) return !0;
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
  function A(e, t, n, r, l, i, u) {
    this.acceptsBooleans = t === 2 || t === 3 || t === 4, this.attributeName = r, this.attributeNamespace = l, this.mustUseProperty = n, this.propertyName = e, this.type = t, this.sanitizeURL = i, this.removeEmptyString = u;
  }
  var $ = {};
  "children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e) {
    $[e] = new A(e, 0, !1, e, null, !1, !1);
  }), [["acceptCharset", "accept-charset"], ["className", "class"], ["htmlFor", "for"], ["httpEquiv", "http-equiv"]].forEach(function(e) {
    var t = e[0];
    $[t] = new A(t, 1, !1, e[1], null, !1, !1);
  }), ["contentEditable", "draggable", "spellCheck", "value"].forEach(function(e) {
    $[e] = new A(e, 2, !1, e.toLowerCase(), null, !1, !1);
  }), ["autoReverse", "externalResourcesRequired", "focusable", "preserveAlpha"].forEach(function(e) {
    $[e] = new A(e, 2, !1, e, null, !1, !1);
  }), "allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e) {
    $[e] = new A(e, 3, !1, e.toLowerCase(), null, !1, !1);
  }), ["checked", "multiple", "muted", "selected"].forEach(function(e) {
    $[e] = new A(e, 3, !0, e, null, !1, !1);
  }), ["capture", "download"].forEach(function(e) {
    $[e] = new A(e, 4, !1, e, null, !1, !1);
  }), ["cols", "rows", "size", "span"].forEach(function(e) {
    $[e] = new A(e, 6, !1, e, null, !1, !1);
  }), ["rowSpan", "start"].forEach(function(e) {
    $[e] = new A(e, 5, !1, e.toLowerCase(), null, !1, !1);
  });
  var ne = /[\-:]([a-z])/g;
  function ve(e) {
    return e[1].toUpperCase();
  }
  "accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e) {
    var t = e.replace(
      ne,
      ve
    );
    $[t] = new A(t, 1, !1, e, null, !1, !1);
  }), "xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e) {
    var t = e.replace(ne, ve);
    $[t] = new A(t, 1, !1, e, "http://www.w3.org/1999/xlink", !1, !1);
  }), ["xml:base", "xml:lang", "xml:space"].forEach(function(e) {
    var t = e.replace(ne, ve);
    $[t] = new A(t, 1, !1, e, "http://www.w3.org/XML/1998/namespace", !1, !1);
  }), ["tabIndex", "crossOrigin"].forEach(function(e) {
    $[e] = new A(e, 1, !1, e.toLowerCase(), null, !1, !1);
  }), $.xlinkHref = new A("xlinkHref", 1, !1, "xlink:href", "http://www.w3.org/1999/xlink", !0, !1), ["src", "href", "action", "formAction"].forEach(function(e) {
    $[e] = new A(e, 1, !1, e.toLowerCase(), null, !0, !0);
  });
  function de(e, t, n, r) {
    var l = $.hasOwnProperty(t) ? $[t] : null;
    (l !== null ? l.type !== 0 : r || !(2 < t.length) || t[0] !== "o" && t[0] !== "O" || t[1] !== "n" && t[1] !== "N") && (K(t, n, l, r) && (n = null), r || l === null ? D(t) && (n === null ? e.removeAttribute(t) : e.setAttribute(t, "" + n)) : l.mustUseProperty ? e[l.propertyName] = n === null ? l.type === 3 ? !1 : "" : n : (t = l.attributeName, r = l.attributeNamespace, n === null ? e.removeAttribute(t) : (l = l.type, n = l === 3 || l === 4 && n === !0 ? "" : "" + n, r ? e.setAttributeNS(r, t, n) : e.setAttribute(t, n))));
  }
  var pe = f.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED, Pe = Symbol.for("react.element"), xe = Symbol.for("react.portal"), ke = Symbol.for("react.fragment"), Ge = Symbol.for("react.strict_mode"), Pt = Symbol.for("react.profiler"), gt = Symbol.for("react.provider"), Yt = Symbol.for("react.context"), ct = Symbol.for("react.forward_ref"), He = Symbol.for("react.suspense"), nt = Symbol.for("react.suspense_list"), ft = Symbol.for("react.memo"), Ie = Symbol.for("react.lazy"), me = Symbol.for("react.offscreen"), C = Symbol.iterator;
  function F(e) {
    return e === null || typeof e != "object" ? null : (e = C && e[C] || e["@@iterator"], typeof e == "function" ? e : null);
  }
  var z = Object.assign, d;
  function g(e) {
    if (d === void 0) try {
      throw Error();
    } catch (n) {
      var t = n.stack.trim().match(/\n( *(at )?)/);
      d = t && t[1] || "";
    }
    return `
` + d + e;
  }
  var B = !1;
  function Q(e, t) {
    if (!e || B) return "";
    B = !0;
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
        } catch (v) {
          var r = v;
        }
        Reflect.construct(e, [], t);
      } else {
        try {
          t.call();
        } catch (v) {
          r = v;
        }
        e.call(t.prototype);
      }
      else {
        try {
          throw Error();
        } catch (v) {
          r = v;
        }
        e();
      }
    } catch (v) {
      if (v && r && typeof v.stack == "string") {
        for (var l = v.stack.split(`
`), i = r.stack.split(`
`), u = l.length - 1, o = i.length - 1; 1 <= u && 0 <= o && l[u] !== i[o]; ) o--;
        for (; 1 <= u && 0 <= o; u--, o--) if (l[u] !== i[o]) {
          if (u !== 1 || o !== 1)
            do
              if (u--, o--, 0 > o || l[u] !== i[o]) {
                var a = `
` + l[u].replace(" at new ", " at ");
                return e.displayName && a.includes("<anonymous>") && (a = a.replace("<anonymous>", e.displayName)), a;
              }
            while (1 <= u && 0 <= o);
          break;
        }
      }
    } finally {
      B = !1, Error.prepareStackTrace = n;
    }
    return (e = e ? e.displayName || e.name : "") ? g(e) : "";
  }
  function Z(e) {
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
        return e = Q(e.type, !1), e;
      case 11:
        return e = Q(e.type.render, !1), e;
      case 1:
        return e = Q(e.type, !0), e;
      default:
        return "";
    }
  }
  function J(e) {
    if (e == null) return null;
    if (typeof e == "function") return e.displayName || e.name || null;
    if (typeof e == "string") return e;
    switch (e) {
      case ke:
        return "Fragment";
      case xe:
        return "Portal";
      case Pt:
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
      case gt:
        return (e._context.displayName || "Context") + ".Provider";
      case ct:
        var t = e.render;
        return e = e.displayName, e || (e = t.displayName || t.name || "", e = e !== "" ? "ForwardRef(" + e + ")" : "ForwardRef"), e;
      case ft:
        return t = e.displayName || null, t !== null ? t : J(e.type) || "Memo";
      case Ie:
        t = e._payload, e = e._init;
        try {
          return J(e(t));
        } catch {
        }
    }
    return null;
  }
  function re(e) {
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
        return J(t);
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
  function ee(e) {
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
  function se(e) {
    var t = e.type;
    return (e = e.nodeName) && e.toLowerCase() === "input" && (t === "checkbox" || t === "radio");
  }
  function We(e) {
    var t = se(e) ? "checked" : "value", n = Object.getOwnPropertyDescriptor(e.constructor.prototype, t), r = "" + e[t];
    if (!e.hasOwnProperty(t) && typeof n < "u" && typeof n.get == "function" && typeof n.set == "function") {
      var l = n.get, i = n.set;
      return Object.defineProperty(e, t, { configurable: !0, get: function() {
        return l.call(this);
      }, set: function(u) {
        r = "" + u, i.call(this, u);
      } }), Object.defineProperty(e, t, { enumerable: n.enumerable }), { getValue: function() {
        return r;
      }, setValue: function(u) {
        r = "" + u;
      }, stopTracking: function() {
        e._valueTracker = null, delete e[t];
      } };
    }
  }
  function wr(e) {
    e._valueTracker || (e._valueTracker = We(e));
  }
  function Lu(e) {
    if (!e) return !1;
    var t = e._valueTracker;
    if (!t) return !0;
    var n = t.getValue(), r = "";
    return e && (r = se(e) ? e.checked ? "true" : "false" : e.value), e = r, e !== n ? (t.setValue(e), !0) : !1;
  }
  function kr(e) {
    if (e = e || (typeof document < "u" ? document : void 0), typeof e > "u") return null;
    try {
      return e.activeElement || e.body;
    } catch {
      return e.body;
    }
  }
  function Rl(e, t) {
    var n = t.checked;
    return z({}, t, { defaultChecked: void 0, defaultValue: void 0, value: void 0, checked: n ?? e._wrapperState.initialChecked });
  }
  function Du(e, t) {
    var n = t.defaultValue == null ? "" : t.defaultValue, r = t.checked != null ? t.checked : t.defaultChecked;
    n = ee(t.value != null ? t.value : n), e._wrapperState = { initialChecked: r, initialValue: n, controlled: t.type === "checkbox" || t.type === "radio" ? t.checked != null : t.value != null };
  }
  function Ou(e, t) {
    t = t.checked, t != null && de(e, "checked", t, !1);
  }
  function Ll(e, t) {
    Ou(e, t);
    var n = ee(t.value), r = t.type;
    if (n != null) r === "number" ? (n === 0 && e.value === "" || e.value != n) && (e.value = "" + n) : e.value !== "" + n && (e.value = "" + n);
    else if (r === "submit" || r === "reset") {
      e.removeAttribute("value");
      return;
    }
    t.hasOwnProperty("value") ? Dl(e, t.type, n) : t.hasOwnProperty("defaultValue") && Dl(e, t.type, ee(t.defaultValue)), t.checked == null && t.defaultChecked != null && (e.defaultChecked = !!t.defaultChecked);
  }
  function Mu(e, t, n) {
    if (t.hasOwnProperty("value") || t.hasOwnProperty("defaultValue")) {
      var r = t.type;
      if (!(r !== "submit" && r !== "reset" || t.value !== void 0 && t.value !== null)) return;
      t = "" + e._wrapperState.initialValue, n || t === e.value || (e.value = t), e.defaultValue = t;
    }
    n = e.name, n !== "" && (e.name = ""), e.defaultChecked = !!e._wrapperState.initialChecked, n !== "" && (e.name = n);
  }
  function Dl(e, t, n) {
    (t !== "number" || kr(e.ownerDocument) !== e) && (n == null ? e.defaultValue = "" + e._wrapperState.initialValue : e.defaultValue !== "" + n && (e.defaultValue = "" + n));
  }
  var Dn = Array.isArray;
  function sn(e, t, n, r) {
    if (e = e.options, t) {
      t = {};
      for (var l = 0; l < n.length; l++) t["$" + n[l]] = !0;
      for (n = 0; n < e.length; n++) l = t.hasOwnProperty("$" + e[n].value), e[n].selected !== l && (e[n].selected = l), l && r && (e[n].defaultSelected = !0);
    } else {
      for (n = "" + ee(n), t = null, l = 0; l < e.length; l++) {
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
    if (t.dangerouslySetInnerHTML != null) throw Error(s(91));
    return z({}, t, { value: void 0, defaultValue: void 0, children: "" + e._wrapperState.initialValue });
  }
  function Iu(e, t) {
    var n = t.value;
    if (n == null) {
      if (n = t.children, t = t.defaultValue, n != null) {
        if (t != null) throw Error(s(92));
        if (Dn(n)) {
          if (1 < n.length) throw Error(s(93));
          n = n[0];
        }
        t = n;
      }
      t == null && (t = ""), n = t;
    }
    e._wrapperState = { initialValue: ee(n) };
  }
  function Fu(e, t) {
    var n = ee(t.value), r = ee(t.defaultValue);
    n != null && (n = "" + n, n !== e.value && (e.value = n), t.defaultValue == null && e.defaultValue !== n && (e.defaultValue = n)), r != null && (e.defaultValue = "" + r);
  }
  function Uu(e) {
    var t = e.textContent;
    t === e._wrapperState.initialValue && t !== "" && t !== null && (e.value = t);
  }
  function Au(e) {
    switch (e) {
      case "svg":
        return "http://www.w3.org/2000/svg";
      case "math":
        return "http://www.w3.org/1998/Math/MathML";
      default:
        return "http://www.w3.org/1999/xhtml";
    }
  }
  function Ml(e, t) {
    return e == null || e === "http://www.w3.org/1999/xhtml" ? Au(t) : e === "http://www.w3.org/2000/svg" && t === "foreignObject" ? "http://www.w3.org/1999/xhtml" : e;
  }
  var Sr, $u = (function(e) {
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
  var Mn = {
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
  Object.keys(Mn).forEach(function(e) {
    Aa.forEach(function(t) {
      t = t + e.charAt(0).toUpperCase() + e.substring(1), Mn[t] = Mn[e];
    });
  });
  function Vu(e, t, n) {
    return t == null || typeof t == "boolean" || t === "" ? "" : n || typeof t != "number" || t === 0 || Mn.hasOwnProperty(e) && Mn[e] ? ("" + t).trim() : t + "px";
  }
  function Bu(e, t) {
    e = e.style;
    for (var n in t) if (t.hasOwnProperty(n)) {
      var r = n.indexOf("--") === 0, l = Vu(n, t[n], r);
      n === "float" && (n = "cssFloat"), r ? e.setProperty(n, l) : e[n] = l;
    }
  }
  var $a = z({ menuitem: !0 }, { area: !0, base: !0, br: !0, col: !0, embed: !0, hr: !0, img: !0, input: !0, keygen: !0, link: !0, meta: !0, param: !0, source: !0, track: !0, wbr: !0 });
  function Il(e, t) {
    if (t) {
      if ($a[e] && (t.children != null || t.dangerouslySetInnerHTML != null)) throw Error(s(137, e));
      if (t.dangerouslySetInnerHTML != null) {
        if (t.children != null) throw Error(s(60));
        if (typeof t.dangerouslySetInnerHTML != "object" || !("__html" in t.dangerouslySetInnerHTML)) throw Error(s(61));
      }
      if (t.style != null && typeof t.style != "object") throw Error(s(62));
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
  var $l = null, an = null, cn = null;
  function Hu(e) {
    if (e = rr(e)) {
      if (typeof $l != "function") throw Error(s(280));
      var t = e.stateNode;
      t && (t = Wr(t), $l(e.stateNode, e.type, t));
    }
  }
  function Wu(e) {
    an ? cn ? cn.push(e) : cn = [e] : an = e;
  }
  function Qu() {
    if (an) {
      var e = an, t = cn;
      if (cn = an = null, Hu(e), t) for (e = 0; e < t.length; e++) Hu(t[e]);
    }
  }
  function Ku(e, t) {
    return e(t);
  }
  function Yu() {
  }
  var Vl = !1;
  function Xu(e, t, n) {
    if (Vl) return e(t, n);
    Vl = !0;
    try {
      return Ku(e, t, n);
    } finally {
      Vl = !1, (an !== null || cn !== null) && (Yu(), Qu());
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
    if (n && typeof n != "function") throw Error(s(231, t, typeof n));
    return n;
  }
  var Bl = !1;
  if (Y) try {
    var Fn = {};
    Object.defineProperty(Fn, "passive", { get: function() {
      Bl = !0;
    } }), window.addEventListener("test", Fn, Fn), window.removeEventListener("test", Fn, Fn);
  } catch {
    Bl = !1;
  }
  function Va(e, t, n, r, l, i, u, o, a) {
    var v = Array.prototype.slice.call(arguments, 3);
    try {
      t.apply(n, v);
    } catch (w) {
      this.onError(w);
    }
  }
  var Un = !1, _r = null, xr = !1, Hl = null, Ba = { onError: function(e) {
    Un = !0, _r = e;
  } };
  function Ha(e, t, n, r, l, i, u, o, a) {
    Un = !1, _r = null, Va.apply(Ba, arguments);
  }
  function Wa(e, t, n, r, l, i, u, o, a) {
    if (Ha.apply(this, arguments), Un) {
      if (Un) {
        var v = _r;
        Un = !1, _r = null;
      } else throw Error(s(198));
      xr || (xr = !0, Hl = v);
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
  function Gu(e) {
    if (e.tag === 13) {
      var t = e.memoizedState;
      if (t === null && (e = e.alternate, e !== null && (t = e.memoizedState)), t !== null) return t.dehydrated;
    }
    return null;
  }
  function Zu(e) {
    if (Xt(e) !== e) throw Error(s(188));
  }
  function Qa(e) {
    var t = e.alternate;
    if (!t) {
      if (t = Xt(e), t === null) throw Error(s(188));
      return t !== e ? null : e;
    }
    for (var n = e, r = t; ; ) {
      var l = n.return;
      if (l === null) break;
      var i = l.alternate;
      if (i === null) {
        if (r = l.return, r !== null) {
          n = r;
          continue;
        }
        break;
      }
      if (l.child === i.child) {
        for (i = l.child; i; ) {
          if (i === n) return Zu(l), e;
          if (i === r) return Zu(l), t;
          i = i.sibling;
        }
        throw Error(s(188));
      }
      if (n.return !== r.return) n = l, r = i;
      else {
        for (var u = !1, o = l.child; o; ) {
          if (o === n) {
            u = !0, n = l, r = i;
            break;
          }
          if (o === r) {
            u = !0, r = l, n = i;
            break;
          }
          o = o.sibling;
        }
        if (!u) {
          for (o = i.child; o; ) {
            if (o === n) {
              u = !0, n = i, r = l;
              break;
            }
            if (o === r) {
              u = !0, r = i, n = l;
              break;
            }
            o = o.sibling;
          }
          if (!u) throw Error(s(189));
        }
      }
      if (n.alternate !== r) throw Error(s(190));
    }
    if (n.tag !== 3) throw Error(s(188));
    return n.stateNode.current === n ? e : t;
  }
  function Ju(e) {
    return e = Qa(e), e !== null ? qu(e) : null;
  }
  function qu(e) {
    if (e.tag === 5 || e.tag === 6) return e;
    for (e = e.child; e !== null; ) {
      var t = qu(e);
      if (t !== null) return t;
      e = e.sibling;
    }
    return null;
  }
  var bu = p.unstable_scheduleCallback, eo = p.unstable_cancelCallback, Ka = p.unstable_shouldYield, Ya = p.unstable_requestPaint, ye = p.unstable_now, Xa = p.unstable_getCurrentPriorityLevel, Wl = p.unstable_ImmediatePriority, to = p.unstable_UserBlockingPriority, Er = p.unstable_NormalPriority, Ga = p.unstable_LowPriority, no = p.unstable_IdlePriority, Cr = null, dt = null;
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
    var r = 0, l = e.suspendedLanes, i = e.pingedLanes, u = n & 268435455;
    if (u !== 0) {
      var o = u & ~l;
      o !== 0 ? r = An(o) : (i &= u, i !== 0 && (r = An(i)));
    } else u = n & ~l, u !== 0 ? r = An(u) : i !== 0 && (r = An(i));
    if (r === 0) return 0;
    if (t !== 0 && t !== r && (t & l) === 0 && (l = r & -r, i = t & -t, l >= i || l === 16 && (i & 4194240) !== 0)) return t;
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
    for (var n = e.suspendedLanes, r = e.pingedLanes, l = e.expirationTimes, i = e.pendingLanes; 0 < i; ) {
      var u = 31 - rt(i), o = 1 << u, a = l[u];
      a === -1 ? ((o & n) === 0 || (o & r) !== 0) && (l[u] = ec(o, t)) : a <= t && (e.expiredLanes |= o), i &= ~o;
    }
  }
  function Ql(e) {
    return e = e.pendingLanes & -1073741825, e !== 0 ? e : e & 1073741824 ? 1073741824 : 0;
  }
  function ro() {
    var e = Nr;
    return Nr <<= 1, (Nr & 4194240) === 0 && (Nr = 64), e;
  }
  function Kl(e) {
    for (var t = [], n = 0; 31 > n; n++) t.push(e);
    return t;
  }
  function $n(e, t, n) {
    e.pendingLanes |= t, t !== 536870912 && (e.suspendedLanes = 0, e.pingedLanes = 0), e = e.eventTimes, t = 31 - rt(t), e[t] = n;
  }
  function nc(e, t) {
    var n = e.pendingLanes & ~t;
    e.pendingLanes = t, e.suspendedLanes = 0, e.pingedLanes = 0, e.expiredLanes &= t, e.mutableReadLanes &= t, e.entangledLanes &= t, t = e.entanglements;
    var r = e.eventTimes;
    for (e = e.expirationTimes; 0 < n; ) {
      var l = 31 - rt(n), i = 1 << l;
      t[l] = 0, r[l] = -1, e[l] = -1, n &= ~i;
    }
  }
  function Yl(e, t) {
    var n = e.entangledLanes |= t;
    for (e = e.entanglements; n; ) {
      var r = 31 - rt(n), l = 1 << r;
      l & t | e[r] & t && (e[r] |= t), n &= ~l;
    }
  }
  var te = 0;
  function lo(e) {
    return e &= -e, 1 < e ? 4 < e ? (e & 268435455) !== 0 ? 16 : 536870912 : 4 : 1;
  }
  var io, Xl, uo, oo, so, Gl = !1, jr = [], zt = null, jt = null, Tt = null, Vn = /* @__PURE__ */ new Map(), Bn = /* @__PURE__ */ new Map(), Rt = [], rc = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");
  function ao(e, t) {
    switch (e) {
      case "focusin":
      case "focusout":
        zt = null;
        break;
      case "dragenter":
      case "dragleave":
        jt = null;
        break;
      case "mouseover":
      case "mouseout":
        Tt = null;
        break;
      case "pointerover":
      case "pointerout":
        Vn.delete(t.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        Bn.delete(t.pointerId);
    }
  }
  function Hn(e, t, n, r, l, i) {
    return e === null || e.nativeEvent !== i ? (e = { blockedOn: t, domEventName: n, eventSystemFlags: r, nativeEvent: i, targetContainers: [l] }, t !== null && (t = rr(t), t !== null && Xl(t)), e) : (e.eventSystemFlags |= r, t = e.targetContainers, l !== null && t.indexOf(l) === -1 && t.push(l), e);
  }
  function lc(e, t, n, r, l) {
    switch (t) {
      case "focusin":
        return zt = Hn(zt, e, t, n, r, l), !0;
      case "dragenter":
        return jt = Hn(jt, e, t, n, r, l), !0;
      case "mouseover":
        return Tt = Hn(Tt, e, t, n, r, l), !0;
      case "pointerover":
        var i = l.pointerId;
        return Vn.set(i, Hn(Vn.get(i) || null, e, t, n, r, l)), !0;
      case "gotpointercapture":
        return i = l.pointerId, Bn.set(i, Hn(Bn.get(i) || null, e, t, n, r, l)), !0;
    }
    return !1;
  }
  function co(e) {
    var t = Gt(e.target);
    if (t !== null) {
      var n = Xt(t);
      if (n !== null) {
        if (t = n.tag, t === 13) {
          if (t = Gu(n), t !== null) {
            e.blockedOn = t, so(e.priority, function() {
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
  function Tr(e) {
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
  function fo(e, t, n) {
    Tr(e) && n.delete(t);
  }
  function ic() {
    Gl = !1, zt !== null && Tr(zt) && (zt = null), jt !== null && Tr(jt) && (jt = null), Tt !== null && Tr(Tt) && (Tt = null), Vn.forEach(fo), Bn.forEach(fo);
  }
  function Wn(e, t) {
    e.blockedOn === t && (e.blockedOn = null, Gl || (Gl = !0, p.unstable_scheduleCallback(p.unstable_NormalPriority, ic)));
  }
  function Qn(e) {
    function t(l) {
      return Wn(l, e);
    }
    if (0 < jr.length) {
      Wn(jr[0], e);
      for (var n = 1; n < jr.length; n++) {
        var r = jr[n];
        r.blockedOn === e && (r.blockedOn = null);
      }
    }
    for (zt !== null && Wn(zt, e), jt !== null && Wn(jt, e), Tt !== null && Wn(Tt, e), Vn.forEach(t), Bn.forEach(t), n = 0; n < Rt.length; n++) r = Rt[n], r.blockedOn === e && (r.blockedOn = null);
    for (; 0 < Rt.length && (n = Rt[0], n.blockedOn === null); ) co(n), n.blockedOn === null && Rt.shift();
  }
  var fn = pe.ReactCurrentBatchConfig, Rr = !0;
  function uc(e, t, n, r) {
    var l = te, i = fn.transition;
    fn.transition = null;
    try {
      te = 1, Zl(e, t, n, r);
    } finally {
      te = l, fn.transition = i;
    }
  }
  function oc(e, t, n, r) {
    var l = te, i = fn.transition;
    fn.transition = null;
    try {
      te = 4, Zl(e, t, n, r);
    } finally {
      te = l, fn.transition = i;
    }
  }
  function Zl(e, t, n, r) {
    if (Rr) {
      var l = Jl(e, t, n, r);
      if (l === null) mi(e, t, r, Lr, n), ao(e, r);
      else if (lc(l, e, t, n, r)) r.stopPropagation();
      else if (ao(e, r), t & 4 && -1 < rc.indexOf(e)) {
        for (; l !== null; ) {
          var i = rr(l);
          if (i !== null && io(i), i = Jl(e, t, n, r), i === null && mi(e, t, r, Lr, n), i === l) break;
          l = i;
        }
        l !== null && r.stopPropagation();
      } else mi(e, t, r, null, n);
    }
  }
  var Lr = null;
  function Jl(e, t, n, r) {
    if (Lr = null, e = Al(r), e = Gt(e), e !== null) if (t = Xt(e), t === null) e = null;
    else if (n = t.tag, n === 13) {
      if (e = Gu(t), e !== null) return e;
      e = null;
    } else if (n === 3) {
      if (t.stateNode.current.memoizedState.isDehydrated) return t.tag === 3 ? t.stateNode.containerInfo : null;
      e = null;
    } else t !== e && (e = null);
    return Lr = e, null;
  }
  function po(e) {
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
          case to:
            return 4;
          case Er:
          case Ga:
            return 16;
          case no:
            return 536870912;
          default:
            return 16;
        }
      default:
        return 16;
    }
  }
  var Lt = null, ql = null, Dr = null;
  function mo() {
    if (Dr) return Dr;
    var e, t = ql, n = t.length, r, l = "value" in Lt ? Lt.value : Lt.textContent, i = l.length;
    for (e = 0; e < n && t[e] === l[e]; e++) ;
    var u = n - e;
    for (r = 1; r <= u && t[n - r] === l[i - r]; r++) ;
    return Dr = l.slice(e, 1 < r ? 1 - r : void 0);
  }
  function Or(e) {
    var t = e.keyCode;
    return "charCode" in e ? (e = e.charCode, e === 0 && t === 13 && (e = 13)) : e = t, e === 10 && (e = 13), 32 <= e || e === 13 ? e : 0;
  }
  function Mr() {
    return !0;
  }
  function ho() {
    return !1;
  }
  function Qe(e) {
    function t(n, r, l, i, u) {
      this._reactName = n, this._targetInst = l, this.type = r, this.nativeEvent = i, this.target = u, this.currentTarget = null;
      for (var o in e) e.hasOwnProperty(o) && (n = e[o], this[o] = n ? n(i) : i[o]);
      return this.isDefaultPrevented = (i.defaultPrevented != null ? i.defaultPrevented : i.returnValue === !1) ? Mr : ho, this.isPropagationStopped = ho, this;
    }
    return z(t.prototype, { preventDefault: function() {
      this.defaultPrevented = !0;
      var n = this.nativeEvent;
      n && (n.preventDefault ? n.preventDefault() : typeof n.returnValue != "unknown" && (n.returnValue = !1), this.isDefaultPrevented = Mr);
    }, stopPropagation: function() {
      var n = this.nativeEvent;
      n && (n.stopPropagation ? n.stopPropagation() : typeof n.cancelBubble != "unknown" && (n.cancelBubble = !0), this.isPropagationStopped = Mr);
    }, persist: function() {
    }, isPersistent: Mr }), t;
  }
  var dn = { eventPhase: 0, bubbles: 0, cancelable: 0, timeStamp: function(e) {
    return e.timeStamp || Date.now();
  }, defaultPrevented: 0, isTrusted: 0 }, bl = Qe(dn), Kn = z({}, dn, { view: 0, detail: 0 }), sc = Qe(Kn), ei, ti, Yn, Ir = z({}, Kn, { screenX: 0, screenY: 0, clientX: 0, clientY: 0, pageX: 0, pageY: 0, ctrlKey: 0, shiftKey: 0, altKey: 0, metaKey: 0, getModifierState: ri, button: 0, buttons: 0, relatedTarget: function(e) {
    return e.relatedTarget === void 0 ? e.fromElement === e.srcElement ? e.toElement : e.fromElement : e.relatedTarget;
  }, movementX: function(e) {
    return "movementX" in e ? e.movementX : (e !== Yn && (Yn && e.type === "mousemove" ? (ei = e.screenX - Yn.screenX, ti = e.screenY - Yn.screenY) : ti = ei = 0, Yn = e), ei);
  }, movementY: function(e) {
    return "movementY" in e ? e.movementY : ti;
  } }), vo = Qe(Ir), ac = z({}, Ir, { dataTransfer: 0 }), cc = Qe(ac), fc = z({}, Kn, { relatedTarget: 0 }), ni = Qe(fc), dc = z({}, dn, { animationName: 0, elapsedTime: 0, pseudoElement: 0 }), pc = Qe(dc), mc = z({}, dn, { clipboardData: function(e) {
    return "clipboardData" in e ? e.clipboardData : window.clipboardData;
  } }), hc = Qe(mc), vc = z({}, dn, { data: 0 }), yo = Qe(vc), yc = {
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
  }, wc = { Alt: "altKey", Control: "ctrlKey", Meta: "metaKey", Shift: "shiftKey" };
  function kc(e) {
    var t = this.nativeEvent;
    return t.getModifierState ? t.getModifierState(e) : (e = wc[e]) ? !!t[e] : !1;
  }
  function ri() {
    return kc;
  }
  var Sc = z({}, Kn, { key: function(e) {
    if (e.key) {
      var t = yc[e.key] || e.key;
      if (t !== "Unidentified") return t;
    }
    return e.type === "keypress" ? (e = Or(e), e === 13 ? "Enter" : String.fromCharCode(e)) : e.type === "keydown" || e.type === "keyup" ? gc[e.keyCode] || "Unidentified" : "";
  }, code: 0, location: 0, ctrlKey: 0, shiftKey: 0, altKey: 0, metaKey: 0, repeat: 0, locale: 0, getModifierState: ri, charCode: function(e) {
    return e.type === "keypress" ? Or(e) : 0;
  }, keyCode: function(e) {
    return e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
  }, which: function(e) {
    return e.type === "keypress" ? Or(e) : e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
  } }), _c = Qe(Sc), xc = z({}, Ir, { pointerId: 0, width: 0, height: 0, pressure: 0, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0, pointerType: 0, isPrimary: 0 }), go = Qe(xc), Ec = z({}, Kn, { touches: 0, targetTouches: 0, changedTouches: 0, altKey: 0, metaKey: 0, ctrlKey: 0, shiftKey: 0, getModifierState: ri }), Cc = Qe(Ec), Nc = z({}, dn, { propertyName: 0, elapsedTime: 0, pseudoElement: 0 }), Pc = Qe(Nc), zc = z({}, Ir, {
    deltaX: function(e) {
      return "deltaX" in e ? e.deltaX : "wheelDeltaX" in e ? -e.wheelDeltaX : 0;
    },
    deltaY: function(e) {
      return "deltaY" in e ? e.deltaY : "wheelDeltaY" in e ? -e.wheelDeltaY : "wheelDelta" in e ? -e.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), jc = Qe(zc), Tc = [9, 13, 27, 32], li = Y && "CompositionEvent" in window, Xn = null;
  Y && "documentMode" in document && (Xn = document.documentMode);
  var Rc = Y && "TextEvent" in window && !Xn, wo = Y && (!li || Xn && 8 < Xn && 11 >= Xn), ko = " ", So = !1;
  function _o(e, t) {
    switch (e) {
      case "keyup":
        return Tc.indexOf(t.keyCode) !== -1;
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
  function xo(e) {
    return e = e.detail, typeof e == "object" && "data" in e ? e.data : null;
  }
  var pn = !1;
  function Lc(e, t) {
    switch (e) {
      case "compositionend":
        return xo(t);
      case "keypress":
        return t.which !== 32 ? null : (So = !0, ko);
      case "textInput":
        return e = t.data, e === ko && So ? null : e;
      default:
        return null;
    }
  }
  function Dc(e, t) {
    if (pn) return e === "compositionend" || !li && _o(e, t) ? (e = mo(), Dr = ql = Lt = null, pn = !1, e) : null;
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
        return wo && t.locale !== "ko" ? null : t.data;
      default:
        return null;
    }
  }
  var Oc = { color: !0, date: !0, datetime: !0, "datetime-local": !0, email: !0, month: !0, number: !0, password: !0, range: !0, search: !0, tel: !0, text: !0, time: !0, url: !0, week: !0 };
  function Eo(e) {
    var t = e && e.nodeName && e.nodeName.toLowerCase();
    return t === "input" ? !!Oc[e.type] : t === "textarea";
  }
  function Co(e, t, n, r) {
    Wu(r), t = Vr(t, "onChange"), 0 < t.length && (n = new bl("onChange", "change", null, n, r), e.push({ event: n, listeners: t }));
  }
  var Gn = null, Zn = null;
  function Mc(e) {
    Ho(e, 0);
  }
  function Fr(e) {
    var t = gn(e);
    if (Lu(t)) return e;
  }
  function Ic(e, t) {
    if (e === "change") return t;
  }
  var No = !1;
  if (Y) {
    var ii;
    if (Y) {
      var ui = "oninput" in document;
      if (!ui) {
        var Po = document.createElement("div");
        Po.setAttribute("oninput", "return;"), ui = typeof Po.oninput == "function";
      }
      ii = ui;
    } else ii = !1;
    No = ii && (!document.documentMode || 9 < document.documentMode);
  }
  function zo() {
    Gn && (Gn.detachEvent("onpropertychange", jo), Zn = Gn = null);
  }
  function jo(e) {
    if (e.propertyName === "value" && Fr(Zn)) {
      var t = [];
      Co(t, Zn, e, Al(e)), Xu(Mc, t);
    }
  }
  function Fc(e, t, n) {
    e === "focusin" ? (zo(), Gn = t, Zn = n, Gn.attachEvent("onpropertychange", jo)) : e === "focusout" && zo();
  }
  function Uc(e) {
    if (e === "selectionchange" || e === "keyup" || e === "keydown") return Fr(Zn);
  }
  function Ac(e, t) {
    if (e === "click") return Fr(t);
  }
  function $c(e, t) {
    if (e === "input" || e === "change") return Fr(t);
  }
  function Vc(e, t) {
    return e === t && (e !== 0 || 1 / e === 1 / t) || e !== e && t !== t;
  }
  var lt = typeof Object.is == "function" ? Object.is : Vc;
  function Jn(e, t) {
    if (lt(e, t)) return !0;
    if (typeof e != "object" || e === null || typeof t != "object" || t === null) return !1;
    var n = Object.keys(e), r = Object.keys(t);
    if (n.length !== r.length) return !1;
    for (r = 0; r < n.length; r++) {
      var l = n[r];
      if (!H.call(t, l) || !lt(e[l], t[l])) return !1;
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
  function Do() {
    for (var e = window, t = kr(); t instanceof e.HTMLIFrameElement; ) {
      try {
        var n = typeof t.contentWindow.location.href == "string";
      } catch {
        n = !1;
      }
      if (n) e = t.contentWindow;
      else break;
      t = kr(e.document);
    }
    return t;
  }
  function oi(e) {
    var t = e && e.nodeName && e.nodeName.toLowerCase();
    return t && (t === "input" && (e.type === "text" || e.type === "search" || e.type === "tel" || e.type === "url" || e.type === "password") || t === "textarea" || e.contentEditable === "true");
  }
  function Bc(e) {
    var t = Do(), n = e.focusedElem, r = e.selectionRange;
    if (t !== n && n && n.ownerDocument && Lo(n.ownerDocument.documentElement, n)) {
      if (r !== null && oi(n)) {
        if (t = r.start, e = r.end, e === void 0 && (e = t), "selectionStart" in n) n.selectionStart = t, n.selectionEnd = Math.min(e, n.value.length);
        else if (e = (t = n.ownerDocument || document) && t.defaultView || window, e.getSelection) {
          e = e.getSelection();
          var l = n.textContent.length, i = Math.min(r.start, l);
          r = r.end === void 0 ? i : Math.min(r.end, l), !e.extend && i > r && (l = r, r = i, i = l), l = Ro(n, i);
          var u = Ro(
            n,
            r
          );
          l && u && (e.rangeCount !== 1 || e.anchorNode !== l.node || e.anchorOffset !== l.offset || e.focusNode !== u.node || e.focusOffset !== u.offset) && (t = t.createRange(), t.setStart(l.node, l.offset), e.removeAllRanges(), i > r ? (e.addRange(t), e.extend(u.node, u.offset)) : (t.setEnd(u.node, u.offset), e.addRange(t)));
        }
      }
      for (t = [], e = n; e = e.parentNode; ) e.nodeType === 1 && t.push({ element: e, left: e.scrollLeft, top: e.scrollTop });
      for (typeof n.focus == "function" && n.focus(), n = 0; n < t.length; n++) e = t[n], e.element.scrollLeft = e.left, e.element.scrollTop = e.top;
    }
  }
  var Hc = Y && "documentMode" in document && 11 >= document.documentMode, mn = null, si = null, qn = null, ai = !1;
  function Oo(e, t, n) {
    var r = n.window === n ? n.document : n.nodeType === 9 ? n : n.ownerDocument;
    ai || mn == null || mn !== kr(r) || (r = mn, "selectionStart" in r && oi(r) ? r = { start: r.selectionStart, end: r.selectionEnd } : (r = (r.ownerDocument && r.ownerDocument.defaultView || window).getSelection(), r = { anchorNode: r.anchorNode, anchorOffset: r.anchorOffset, focusNode: r.focusNode, focusOffset: r.focusOffset }), qn && Jn(qn, r) || (qn = r, r = Vr(si, "onSelect"), 0 < r.length && (t = new bl("onSelect", "select", null, t, n), e.push({ event: t, listeners: r }), t.target = mn)));
  }
  function Ur(e, t) {
    var n = {};
    return n[e.toLowerCase()] = t.toLowerCase(), n["Webkit" + e] = "webkit" + t, n["Moz" + e] = "moz" + t, n;
  }
  var hn = { animationend: Ur("Animation", "AnimationEnd"), animationiteration: Ur("Animation", "AnimationIteration"), animationstart: Ur("Animation", "AnimationStart"), transitionend: Ur("Transition", "TransitionEnd") }, ci = {}, Mo = {};
  Y && (Mo = document.createElement("div").style, "AnimationEvent" in window || (delete hn.animationend.animation, delete hn.animationiteration.animation, delete hn.animationstart.animation), "TransitionEvent" in window || delete hn.transitionend.transition);
  function Ar(e) {
    if (ci[e]) return ci[e];
    if (!hn[e]) return e;
    var t = hn[e], n;
    for (n in t) if (t.hasOwnProperty(n) && n in Mo) return ci[e] = t[n];
    return e;
  }
  var Io = Ar("animationend"), Fo = Ar("animationiteration"), Uo = Ar("animationstart"), Ao = Ar("transitionend"), $o = /* @__PURE__ */ new Map(), Vo = "abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");
  function Dt(e, t) {
    $o.set(e, t), I(t, [e]);
  }
  for (var fi = 0; fi < Vo.length; fi++) {
    var di = Vo[fi], Wc = di.toLowerCase(), Qc = di[0].toUpperCase() + di.slice(1);
    Dt(Wc, "on" + Qc);
  }
  Dt(Io, "onAnimationEnd"), Dt(Fo, "onAnimationIteration"), Dt(Uo, "onAnimationStart"), Dt("dblclick", "onDoubleClick"), Dt("focusin", "onFocus"), Dt("focusout", "onBlur"), Dt(Ao, "onTransitionEnd"), V("onMouseEnter", ["mouseout", "mouseover"]), V("onMouseLeave", ["mouseout", "mouseover"]), V("onPointerEnter", ["pointerout", "pointerover"]), V("onPointerLeave", ["pointerout", "pointerover"]), I("onChange", "change click focusin focusout input keydown keyup selectionchange".split(" ")), I("onSelect", "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" ")), I("onBeforeInput", ["compositionend", "keypress", "textInput", "paste"]), I("onCompositionEnd", "compositionend focusout keydown keypress keyup mousedown".split(" ")), I("onCompositionStart", "compositionstart focusout keydown keypress keyup mousedown".split(" ")), I("onCompositionUpdate", "compositionupdate focusout keydown keypress keyup mousedown".split(" "));
  var bn = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "), Kc = new Set("cancel close invalid load scroll toggle".split(" ").concat(bn));
  function Bo(e, t, n) {
    var r = e.type || "unknown-event";
    e.currentTarget = n, Wa(r, t, void 0, e), e.currentTarget = null;
  }
  function Ho(e, t) {
    t = (t & 4) !== 0;
    for (var n = 0; n < e.length; n++) {
      var r = e[n], l = r.event;
      r = r.listeners;
      e: {
        var i = void 0;
        if (t) for (var u = r.length - 1; 0 <= u; u--) {
          var o = r[u], a = o.instance, v = o.currentTarget;
          if (o = o.listener, a !== i && l.isPropagationStopped()) break e;
          Bo(l, o, v), i = a;
        }
        else for (u = 0; u < r.length; u++) {
          if (o = r[u], a = o.instance, v = o.currentTarget, o = o.listener, a !== i && l.isPropagationStopped()) break e;
          Bo(l, o, v), i = a;
        }
      }
    }
    if (xr) throw e = Hl, xr = !1, Hl = null, e;
  }
  function ie(e, t) {
    var n = t[ki];
    n === void 0 && (n = t[ki] = /* @__PURE__ */ new Set());
    var r = e + "__bubble";
    n.has(r) || (Wo(t, e, 2, !1), n.add(r));
  }
  function pi(e, t, n) {
    var r = 0;
    t && (r |= 4), Wo(n, e, r, t);
  }
  var $r = "_reactListening" + Math.random().toString(36).slice(2);
  function er(e) {
    if (!e[$r]) {
      e[$r] = !0, _.forEach(function(n) {
        n !== "selectionchange" && (Kc.has(n) || pi(n, !1, e), pi(n, !0, e));
      });
      var t = e.nodeType === 9 ? e : e.ownerDocument;
      t === null || t[$r] || (t[$r] = !0, pi("selectionchange", !1, t));
    }
  }
  function Wo(e, t, n, r) {
    switch (po(t)) {
      case 1:
        var l = uc;
        break;
      case 4:
        l = oc;
        break;
      default:
        l = Zl;
    }
    n = l.bind(null, t, n, e), l = void 0, !Bl || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (l = !0), r ? l !== void 0 ? e.addEventListener(t, n, { capture: !0, passive: l }) : e.addEventListener(t, n, !0) : l !== void 0 ? e.addEventListener(t, n, { passive: l }) : e.addEventListener(t, n, !1);
  }
  function mi(e, t, n, r, l) {
    var i = r;
    if ((t & 1) === 0 && (t & 2) === 0 && r !== null) e: for (; ; ) {
      if (r === null) return;
      var u = r.tag;
      if (u === 3 || u === 4) {
        var o = r.stateNode.containerInfo;
        if (o === l || o.nodeType === 8 && o.parentNode === l) break;
        if (u === 4) for (u = r.return; u !== null; ) {
          var a = u.tag;
          if ((a === 3 || a === 4) && (a = u.stateNode.containerInfo, a === l || a.nodeType === 8 && a.parentNode === l)) return;
          u = u.return;
        }
        for (; o !== null; ) {
          if (u = Gt(o), u === null) return;
          if (a = u.tag, a === 5 || a === 6) {
            r = i = u;
            continue e;
          }
          o = o.parentNode;
        }
      }
      r = r.return;
    }
    Xu(function() {
      var v = i, w = Al(n), k = [];
      e: {
        var y = $o.get(e);
        if (y !== void 0) {
          var N = bl, j = e;
          switch (e) {
            case "keypress":
              if (Or(n) === 0) break e;
            case "keydown":
            case "keyup":
              N = _c;
              break;
            case "focusin":
              j = "focus", N = ni;
              break;
            case "focusout":
              j = "blur", N = ni;
              break;
            case "beforeblur":
            case "afterblur":
              N = ni;
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
              N = vo;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              N = cc;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              N = Cc;
              break;
            case Io:
            case Fo:
            case Uo:
              N = pc;
              break;
            case Ao:
              N = Pc;
              break;
            case "scroll":
              N = sc;
              break;
            case "wheel":
              N = jc;
              break;
            case "copy":
            case "cut":
            case "paste":
              N = hc;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              N = go;
          }
          var T = (t & 4) !== 0, ge = !T && e === "scroll", m = T ? y !== null ? y + "Capture" : null : y;
          T = [];
          for (var c = v, h; c !== null; ) {
            h = c;
            var S = h.stateNode;
            if (h.tag === 5 && S !== null && (h = S, m !== null && (S = In(c, m), S != null && T.push(tr(c, S, h)))), ge) break;
            c = c.return;
          }
          0 < T.length && (y = new N(y, j, null, n, w), k.push({ event: y, listeners: T }));
        }
      }
      if ((t & 7) === 0) {
        e: {
          if (y = e === "mouseover" || e === "pointerover", N = e === "mouseout" || e === "pointerout", y && n !== Ul && (j = n.relatedTarget || n.fromElement) && (Gt(j) || j[wt])) break e;
          if ((N || y) && (y = w.window === w ? w : (y = w.ownerDocument) ? y.defaultView || y.parentWindow : window, N ? (j = n.relatedTarget || n.toElement, N = v, j = j ? Gt(j) : null, j !== null && (ge = Xt(j), j !== ge || j.tag !== 5 && j.tag !== 6) && (j = null)) : (N = null, j = v), N !== j)) {
            if (T = vo, S = "onMouseLeave", m = "onMouseEnter", c = "mouse", (e === "pointerout" || e === "pointerover") && (T = go, S = "onPointerLeave", m = "onPointerEnter", c = "pointer"), ge = N == null ? y : gn(N), h = j == null ? y : gn(j), y = new T(S, c + "leave", N, n, w), y.target = ge, y.relatedTarget = h, S = null, Gt(w) === v && (T = new T(m, c + "enter", j, n, w), T.target = h, T.relatedTarget = ge, S = T), ge = S, N && j) t: {
              for (T = N, m = j, c = 0, h = T; h; h = vn(h)) c++;
              for (h = 0, S = m; S; S = vn(S)) h++;
              for (; 0 < c - h; ) T = vn(T), c--;
              for (; 0 < h - c; ) m = vn(m), h--;
              for (; c--; ) {
                if (T === m || m !== null && T === m.alternate) break t;
                T = vn(T), m = vn(m);
              }
              T = null;
            }
            else T = null;
            N !== null && Qo(k, y, N, T, !1), j !== null && ge !== null && Qo(k, ge, j, T, !0);
          }
        }
        e: {
          if (y = v ? gn(v) : window, N = y.nodeName && y.nodeName.toLowerCase(), N === "select" || N === "input" && y.type === "file") var R = Ic;
          else if (Eo(y)) if (No) R = $c;
          else {
            R = Uc;
            var O = Fc;
          }
          else (N = y.nodeName) && N.toLowerCase() === "input" && (y.type === "checkbox" || y.type === "radio") && (R = Ac);
          if (R && (R = R(e, v))) {
            Co(k, R, n, w);
            break e;
          }
          O && O(e, y, v), e === "focusout" && (O = y._wrapperState) && O.controlled && y.type === "number" && Dl(y, "number", y.value);
        }
        switch (O = v ? gn(v) : window, e) {
          case "focusin":
            (Eo(O) || O.contentEditable === "true") && (mn = O, si = v, qn = null);
            break;
          case "focusout":
            qn = si = mn = null;
            break;
          case "mousedown":
            ai = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            ai = !1, Oo(k, n, w);
            break;
          case "selectionchange":
            if (Hc) break;
          case "keydown":
          case "keyup":
            Oo(k, n, w);
        }
        var M;
        if (li) e: {
          switch (e) {
            case "compositionstart":
              var U = "onCompositionStart";
              break e;
            case "compositionend":
              U = "onCompositionEnd";
              break e;
            case "compositionupdate":
              U = "onCompositionUpdate";
              break e;
          }
          U = void 0;
        }
        else pn ? _o(e, n) && (U = "onCompositionEnd") : e === "keydown" && n.keyCode === 229 && (U = "onCompositionStart");
        U && (wo && n.locale !== "ko" && (pn || U !== "onCompositionStart" ? U === "onCompositionEnd" && pn && (M = mo()) : (Lt = w, ql = "value" in Lt ? Lt.value : Lt.textContent, pn = !0)), O = Vr(v, U), 0 < O.length && (U = new yo(U, e, null, n, w), k.push({ event: U, listeners: O }), M ? U.data = M : (M = xo(n), M !== null && (U.data = M)))), (M = Rc ? Lc(e, n) : Dc(e, n)) && (v = Vr(v, "onBeforeInput"), 0 < v.length && (w = new yo("onBeforeInput", "beforeinput", null, n, w), k.push({ event: w, listeners: v }), w.data = M));
      }
      Ho(k, t);
    });
  }
  function tr(e, t, n) {
    return { instance: e, listener: t, currentTarget: n };
  }
  function Vr(e, t) {
    for (var n = t + "Capture", r = []; e !== null; ) {
      var l = e, i = l.stateNode;
      l.tag === 5 && i !== null && (l = i, i = In(e, n), i != null && r.unshift(tr(e, i, l)), i = In(e, t), i != null && r.push(tr(e, i, l))), e = e.return;
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
  function Qo(e, t, n, r, l) {
    for (var i = t._reactName, u = []; n !== null && n !== r; ) {
      var o = n, a = o.alternate, v = o.stateNode;
      if (a !== null && a === r) break;
      o.tag === 5 && v !== null && (o = v, l ? (a = In(n, i), a != null && u.unshift(tr(n, a, o))) : l || (a = In(n, i), a != null && u.push(tr(n, a, o)))), n = n.return;
    }
    u.length !== 0 && e.push({ event: t, listeners: u });
  }
  var Yc = /\r\n?/g, Xc = /\u0000|\uFFFD/g;
  function Ko(e) {
    return (typeof e == "string" ? e : "" + e).replace(Yc, `
`).replace(Xc, "");
  }
  function Br(e, t, n) {
    if (t = Ko(t), Ko(e) !== t && n) throw Error(s(425));
  }
  function Hr() {
  }
  var hi = null, vi = null;
  function yi(e, t) {
    return e === "textarea" || e === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
  }
  var gi = typeof setTimeout == "function" ? setTimeout : void 0, Gc = typeof clearTimeout == "function" ? clearTimeout : void 0, Yo = typeof Promise == "function" ? Promise : void 0, Zc = typeof queueMicrotask == "function" ? queueMicrotask : typeof Yo < "u" ? function(e) {
    return Yo.resolve(null).then(e).catch(Jc);
  } : gi;
  function Jc(e) {
    setTimeout(function() {
      throw e;
    });
  }
  function wi(e, t) {
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
  function Ot(e) {
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
  function Xo(e) {
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
  var yn = Math.random().toString(36).slice(2), pt = "__reactFiber$" + yn, nr = "__reactProps$" + yn, wt = "__reactContainer$" + yn, ki = "__reactEvents$" + yn, qc = "__reactListeners$" + yn, bc = "__reactHandles$" + yn;
  function Gt(e) {
    var t = e[pt];
    if (t) return t;
    for (var n = e.parentNode; n; ) {
      if (t = n[wt] || n[pt]) {
        if (n = t.alternate, t.child !== null || n !== null && n.child !== null) for (e = Xo(e); e !== null; ) {
          if (n = e[pt]) return n;
          e = Xo(e);
        }
        return t;
      }
      e = n, n = e.parentNode;
    }
    return null;
  }
  function rr(e) {
    return e = e[pt] || e[wt], !e || e.tag !== 5 && e.tag !== 6 && e.tag !== 13 && e.tag !== 3 ? null : e;
  }
  function gn(e) {
    if (e.tag === 5 || e.tag === 6) return e.stateNode;
    throw Error(s(33));
  }
  function Wr(e) {
    return e[nr] || null;
  }
  var Si = [], wn = -1;
  function Mt(e) {
    return { current: e };
  }
  function ue(e) {
    0 > wn || (e.current = Si[wn], Si[wn] = null, wn--);
  }
  function le(e, t) {
    wn++, Si[wn] = e.current, e.current = t;
  }
  var It = {}, Te = Mt(It), Fe = Mt(!1), Zt = It;
  function kn(e, t) {
    var n = e.type.contextTypes;
    if (!n) return It;
    var r = e.stateNode;
    if (r && r.__reactInternalMemoizedUnmaskedChildContext === t) return r.__reactInternalMemoizedMaskedChildContext;
    var l = {}, i;
    for (i in n) l[i] = t[i];
    return r && (e = e.stateNode, e.__reactInternalMemoizedUnmaskedChildContext = t, e.__reactInternalMemoizedMaskedChildContext = l), l;
  }
  function Ue(e) {
    return e = e.childContextTypes, e != null;
  }
  function Qr() {
    ue(Fe), ue(Te);
  }
  function Go(e, t, n) {
    if (Te.current !== It) throw Error(s(168));
    le(Te, t), le(Fe, n);
  }
  function Zo(e, t, n) {
    var r = e.stateNode;
    if (t = t.childContextTypes, typeof r.getChildContext != "function") return n;
    r = r.getChildContext();
    for (var l in r) if (!(l in t)) throw Error(s(108, re(e) || "Unknown", l));
    return z({}, n, r);
  }
  function Kr(e) {
    return e = (e = e.stateNode) && e.__reactInternalMemoizedMergedChildContext || It, Zt = Te.current, le(Te, e), le(Fe, Fe.current), !0;
  }
  function Jo(e, t, n) {
    var r = e.stateNode;
    if (!r) throw Error(s(169));
    n ? (e = Zo(e, t, Zt), r.__reactInternalMemoizedMergedChildContext = e, ue(Fe), ue(Te), le(Te, e)) : ue(Fe), le(Fe, n);
  }
  var kt = null, Yr = !1, _i = !1;
  function qo(e) {
    kt === null ? kt = [e] : kt.push(e);
  }
  function ef(e) {
    Yr = !0, qo(e);
  }
  function Ft() {
    if (!_i && kt !== null) {
      _i = !0;
      var e = 0, t = te;
      try {
        var n = kt;
        for (te = 1; e < n.length; e++) {
          var r = n[e];
          do
            r = r(!0);
          while (r !== null);
        }
        kt = null, Yr = !1;
      } catch (l) {
        throw kt !== null && (kt = kt.slice(e + 1)), bu(Wl, Ft), l;
      } finally {
        te = t, _i = !1;
      }
    }
    return null;
  }
  var Sn = [], _n = 0, Xr = null, Gr = 0, Ze = [], Je = 0, Jt = null, St = 1, _t = "";
  function qt(e, t) {
    Sn[_n++] = Gr, Sn[_n++] = Xr, Xr = e, Gr = t;
  }
  function bo(e, t, n) {
    Ze[Je++] = St, Ze[Je++] = _t, Ze[Je++] = Jt, Jt = e;
    var r = St;
    e = _t;
    var l = 32 - rt(r) - 1;
    r &= ~(1 << l), n += 1;
    var i = 32 - rt(t) + l;
    if (30 < i) {
      var u = l - l % 5;
      i = (r & (1 << u) - 1).toString(32), r >>= u, l -= u, St = 1 << 32 - rt(t) + l | n << l | r, _t = i + e;
    } else St = 1 << i | n << l | r, _t = e;
  }
  function xi(e) {
    e.return !== null && (qt(e, 1), bo(e, 1, 0));
  }
  function Ei(e) {
    for (; e === Xr; ) Xr = Sn[--_n], Sn[_n] = null, Gr = Sn[--_n], Sn[_n] = null;
    for (; e === Jt; ) Jt = Ze[--Je], Ze[Je] = null, _t = Ze[--Je], Ze[Je] = null, St = Ze[--Je], Ze[Je] = null;
  }
  var Ke = null, Ye = null, ae = !1, it = null;
  function es(e, t) {
    var n = tt(5, null, null, 0);
    n.elementType = "DELETED", n.stateNode = t, n.return = e, t = e.deletions, t === null ? (e.deletions = [n], e.flags |= 16) : t.push(n);
  }
  function ts(e, t) {
    switch (e.tag) {
      case 5:
        var n = e.type;
        return t = t.nodeType !== 1 || n.toLowerCase() !== t.nodeName.toLowerCase() ? null : t, t !== null ? (e.stateNode = t, Ke = e, Ye = Ot(t.firstChild), !0) : !1;
      case 6:
        return t = e.pendingProps === "" || t.nodeType !== 3 ? null : t, t !== null ? (e.stateNode = t, Ke = e, Ye = null, !0) : !1;
      case 13:
        return t = t.nodeType !== 8 ? null : t, t !== null ? (n = Jt !== null ? { id: St, overflow: _t } : null, e.memoizedState = { dehydrated: t, treeContext: n, retryLane: 1073741824 }, n = tt(18, null, null, 0), n.stateNode = t, n.return = e, e.child = n, Ke = e, Ye = null, !0) : !1;
      default:
        return !1;
    }
  }
  function Ci(e) {
    return (e.mode & 1) !== 0 && (e.flags & 128) === 0;
  }
  function Ni(e) {
    if (ae) {
      var t = Ye;
      if (t) {
        var n = t;
        if (!ts(e, t)) {
          if (Ci(e)) throw Error(s(418));
          t = Ot(n.nextSibling);
          var r = Ke;
          t && ts(e, t) ? es(r, n) : (e.flags = e.flags & -4097 | 2, ae = !1, Ke = e);
        }
      } else {
        if (Ci(e)) throw Error(s(418));
        e.flags = e.flags & -4097 | 2, ae = !1, Ke = e;
      }
    }
  }
  function ns(e) {
    for (e = e.return; e !== null && e.tag !== 5 && e.tag !== 3 && e.tag !== 13; ) e = e.return;
    Ke = e;
  }
  function Zr(e) {
    if (e !== Ke) return !1;
    if (!ae) return ns(e), ae = !0, !1;
    var t;
    if ((t = e.tag !== 3) && !(t = e.tag !== 5) && (t = e.type, t = t !== "head" && t !== "body" && !yi(e.type, e.memoizedProps)), t && (t = Ye)) {
      if (Ci(e)) throw rs(), Error(s(418));
      for (; t; ) es(e, t), t = Ot(t.nextSibling);
    }
    if (ns(e), e.tag === 13) {
      if (e = e.memoizedState, e = e !== null ? e.dehydrated : null, !e) throw Error(s(317));
      e: {
        for (e = e.nextSibling, t = 0; e; ) {
          if (e.nodeType === 8) {
            var n = e.data;
            if (n === "/$") {
              if (t === 0) {
                Ye = Ot(e.nextSibling);
                break e;
              }
              t--;
            } else n !== "$" && n !== "$!" && n !== "$?" || t++;
          }
          e = e.nextSibling;
        }
        Ye = null;
      }
    } else Ye = Ke ? Ot(e.stateNode.nextSibling) : null;
    return !0;
  }
  function rs() {
    for (var e = Ye; e; ) e = Ot(e.nextSibling);
  }
  function xn() {
    Ye = Ke = null, ae = !1;
  }
  function Pi(e) {
    it === null ? it = [e] : it.push(e);
  }
  var tf = pe.ReactCurrentBatchConfig;
  function lr(e, t, n) {
    if (e = n.ref, e !== null && typeof e != "function" && typeof e != "object") {
      if (n._owner) {
        if (n = n._owner, n) {
          if (n.tag !== 1) throw Error(s(309));
          var r = n.stateNode;
        }
        if (!r) throw Error(s(147, e));
        var l = r, i = "" + e;
        return t !== null && t.ref !== null && typeof t.ref == "function" && t.ref._stringRef === i ? t.ref : (t = function(u) {
          var o = l.refs;
          u === null ? delete o[i] : o[i] = u;
        }, t._stringRef = i, t);
      }
      if (typeof e != "string") throw Error(s(284));
      if (!n._owner) throw Error(s(290, e));
    }
    return e;
  }
  function Jr(e, t) {
    throw e = Object.prototype.toString.call(t), Error(s(31, e === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : e));
  }
  function ls(e) {
    var t = e._init;
    return t(e._payload);
  }
  function is(e) {
    function t(m, c) {
      if (e) {
        var h = m.deletions;
        h === null ? (m.deletions = [c], m.flags |= 16) : h.push(c);
      }
    }
    function n(m, c) {
      if (!e) return null;
      for (; c !== null; ) t(m, c), c = c.sibling;
      return null;
    }
    function r(m, c) {
      for (m = /* @__PURE__ */ new Map(); c !== null; ) c.key !== null ? m.set(c.key, c) : m.set(c.index, c), c = c.sibling;
      return m;
    }
    function l(m, c) {
      return m = Qt(m, c), m.index = 0, m.sibling = null, m;
    }
    function i(m, c, h) {
      return m.index = h, e ? (h = m.alternate, h !== null ? (h = h.index, h < c ? (m.flags |= 2, c) : h) : (m.flags |= 2, c)) : (m.flags |= 1048576, c);
    }
    function u(m) {
      return e && m.alternate === null && (m.flags |= 2), m;
    }
    function o(m, c, h, S) {
      return c === null || c.tag !== 6 ? (c = gu(h, m.mode, S), c.return = m, c) : (c = l(c, h), c.return = m, c);
    }
    function a(m, c, h, S) {
      var R = h.type;
      return R === ke ? w(m, c, h.props.children, S, h.key) : c !== null && (c.elementType === R || typeof R == "object" && R !== null && R.$$typeof === Ie && ls(R) === c.type) ? (S = l(c, h.props), S.ref = lr(m, c, h), S.return = m, S) : (S = Sl(h.type, h.key, h.props, null, m.mode, S), S.ref = lr(m, c, h), S.return = m, S);
    }
    function v(m, c, h, S) {
      return c === null || c.tag !== 4 || c.stateNode.containerInfo !== h.containerInfo || c.stateNode.implementation !== h.implementation ? (c = wu(h, m.mode, S), c.return = m, c) : (c = l(c, h.children || []), c.return = m, c);
    }
    function w(m, c, h, S, R) {
      return c === null || c.tag !== 7 ? (c = on(h, m.mode, S, R), c.return = m, c) : (c = l(c, h), c.return = m, c);
    }
    function k(m, c, h) {
      if (typeof c == "string" && c !== "" || typeof c == "number") return c = gu("" + c, m.mode, h), c.return = m, c;
      if (typeof c == "object" && c !== null) {
        switch (c.$$typeof) {
          case Pe:
            return h = Sl(c.type, c.key, c.props, null, m.mode, h), h.ref = lr(m, null, c), h.return = m, h;
          case xe:
            return c = wu(c, m.mode, h), c.return = m, c;
          case Ie:
            var S = c._init;
            return k(m, S(c._payload), h);
        }
        if (Dn(c) || F(c)) return c = on(c, m.mode, h, null), c.return = m, c;
        Jr(m, c);
      }
      return null;
    }
    function y(m, c, h, S) {
      var R = c !== null ? c.key : null;
      if (typeof h == "string" && h !== "" || typeof h == "number") return R !== null ? null : o(m, c, "" + h, S);
      if (typeof h == "object" && h !== null) {
        switch (h.$$typeof) {
          case Pe:
            return h.key === R ? a(m, c, h, S) : null;
          case xe:
            return h.key === R ? v(m, c, h, S) : null;
          case Ie:
            return R = h._init, y(
              m,
              c,
              R(h._payload),
              S
            );
        }
        if (Dn(h) || F(h)) return R !== null ? null : w(m, c, h, S, null);
        Jr(m, h);
      }
      return null;
    }
    function N(m, c, h, S, R) {
      if (typeof S == "string" && S !== "" || typeof S == "number") return m = m.get(h) || null, o(c, m, "" + S, R);
      if (typeof S == "object" && S !== null) {
        switch (S.$$typeof) {
          case Pe:
            return m = m.get(S.key === null ? h : S.key) || null, a(c, m, S, R);
          case xe:
            return m = m.get(S.key === null ? h : S.key) || null, v(c, m, S, R);
          case Ie:
            var O = S._init;
            return N(m, c, h, O(S._payload), R);
        }
        if (Dn(S) || F(S)) return m = m.get(h) || null, w(c, m, S, R, null);
        Jr(c, S);
      }
      return null;
    }
    function j(m, c, h, S) {
      for (var R = null, O = null, M = c, U = c = 0, Ne = null; M !== null && U < h.length; U++) {
        M.index > U ? (Ne = M, M = null) : Ne = M.sibling;
        var q = y(m, M, h[U], S);
        if (q === null) {
          M === null && (M = Ne);
          break;
        }
        e && M && q.alternate === null && t(m, M), c = i(q, c, U), O === null ? R = q : O.sibling = q, O = q, M = Ne;
      }
      if (U === h.length) return n(m, M), ae && qt(m, U), R;
      if (M === null) {
        for (; U < h.length; U++) M = k(m, h[U], S), M !== null && (c = i(M, c, U), O === null ? R = M : O.sibling = M, O = M);
        return ae && qt(m, U), R;
      }
      for (M = r(m, M); U < h.length; U++) Ne = N(M, m, U, h[U], S), Ne !== null && (e && Ne.alternate !== null && M.delete(Ne.key === null ? U : Ne.key), c = i(Ne, c, U), O === null ? R = Ne : O.sibling = Ne, O = Ne);
      return e && M.forEach(function(Kt) {
        return t(m, Kt);
      }), ae && qt(m, U), R;
    }
    function T(m, c, h, S) {
      var R = F(h);
      if (typeof R != "function") throw Error(s(150));
      if (h = R.call(h), h == null) throw Error(s(151));
      for (var O = R = null, M = c, U = c = 0, Ne = null, q = h.next(); M !== null && !q.done; U++, q = h.next()) {
        M.index > U ? (Ne = M, M = null) : Ne = M.sibling;
        var Kt = y(m, M, q.value, S);
        if (Kt === null) {
          M === null && (M = Ne);
          break;
        }
        e && M && Kt.alternate === null && t(m, M), c = i(Kt, c, U), O === null ? R = Kt : O.sibling = Kt, O = Kt, M = Ne;
      }
      if (q.done) return n(
        m,
        M
      ), ae && qt(m, U), R;
      if (M === null) {
        for (; !q.done; U++, q = h.next()) q = k(m, q.value, S), q !== null && (c = i(q, c, U), O === null ? R = q : O.sibling = q, O = q);
        return ae && qt(m, U), R;
      }
      for (M = r(m, M); !q.done; U++, q = h.next()) q = N(M, m, U, q.value, S), q !== null && (e && q.alternate !== null && M.delete(q.key === null ? U : q.key), c = i(q, c, U), O === null ? R = q : O.sibling = q, O = q);
      return e && M.forEach(function(Mf) {
        return t(m, Mf);
      }), ae && qt(m, U), R;
    }
    function ge(m, c, h, S) {
      if (typeof h == "object" && h !== null && h.type === ke && h.key === null && (h = h.props.children), typeof h == "object" && h !== null) {
        switch (h.$$typeof) {
          case Pe:
            e: {
              for (var R = h.key, O = c; O !== null; ) {
                if (O.key === R) {
                  if (R = h.type, R === ke) {
                    if (O.tag === 7) {
                      n(m, O.sibling), c = l(O, h.props.children), c.return = m, m = c;
                      break e;
                    }
                  } else if (O.elementType === R || typeof R == "object" && R !== null && R.$$typeof === Ie && ls(R) === O.type) {
                    n(m, O.sibling), c = l(O, h.props), c.ref = lr(m, O, h), c.return = m, m = c;
                    break e;
                  }
                  n(m, O);
                  break;
                } else t(m, O);
                O = O.sibling;
              }
              h.type === ke ? (c = on(h.props.children, m.mode, S, h.key), c.return = m, m = c) : (S = Sl(h.type, h.key, h.props, null, m.mode, S), S.ref = lr(m, c, h), S.return = m, m = S);
            }
            return u(m);
          case xe:
            e: {
              for (O = h.key; c !== null; ) {
                if (c.key === O) if (c.tag === 4 && c.stateNode.containerInfo === h.containerInfo && c.stateNode.implementation === h.implementation) {
                  n(m, c.sibling), c = l(c, h.children || []), c.return = m, m = c;
                  break e;
                } else {
                  n(m, c);
                  break;
                }
                else t(m, c);
                c = c.sibling;
              }
              c = wu(h, m.mode, S), c.return = m, m = c;
            }
            return u(m);
          case Ie:
            return O = h._init, ge(m, c, O(h._payload), S);
        }
        if (Dn(h)) return j(m, c, h, S);
        if (F(h)) return T(m, c, h, S);
        Jr(m, h);
      }
      return typeof h == "string" && h !== "" || typeof h == "number" ? (h = "" + h, c !== null && c.tag === 6 ? (n(m, c.sibling), c = l(c, h), c.return = m, m = c) : (n(m, c), c = gu(h, m.mode, S), c.return = m, m = c), u(m)) : n(m, c);
    }
    return ge;
  }
  var En = is(!0), us = is(!1), qr = Mt(null), br = null, Cn = null, zi = null;
  function ji() {
    zi = Cn = br = null;
  }
  function Ti(e) {
    var t = qr.current;
    ue(qr), e._currentValue = t;
  }
  function Ri(e, t, n) {
    for (; e !== null; ) {
      var r = e.alternate;
      if ((e.childLanes & t) !== t ? (e.childLanes |= t, r !== null && (r.childLanes |= t)) : r !== null && (r.childLanes & t) !== t && (r.childLanes |= t), e === n) break;
      e = e.return;
    }
  }
  function Nn(e, t) {
    br = e, zi = Cn = null, e = e.dependencies, e !== null && e.firstContext !== null && ((e.lanes & t) !== 0 && (Ae = !0), e.firstContext = null);
  }
  function qe(e) {
    var t = e._currentValue;
    if (zi !== e) if (e = { context: e, memoizedValue: t, next: null }, Cn === null) {
      if (br === null) throw Error(s(308));
      Cn = e, br.dependencies = { lanes: 0, firstContext: e };
    } else Cn = Cn.next = e;
    return t;
  }
  var bt = null;
  function Li(e) {
    bt === null ? bt = [e] : bt.push(e);
  }
  function os(e, t, n, r) {
    var l = t.interleaved;
    return l === null ? (n.next = n, Li(t)) : (n.next = l.next, l.next = n), t.interleaved = n, xt(e, r);
  }
  function xt(e, t) {
    e.lanes |= t;
    var n = e.alternate;
    for (n !== null && (n.lanes |= t), n = e, e = e.return; e !== null; ) e.childLanes |= t, n = e.alternate, n !== null && (n.childLanes |= t), n = e, e = e.return;
    return n.tag === 3 ? n.stateNode : null;
  }
  var Ut = !1;
  function Di(e) {
    e.updateQueue = { baseState: e.memoizedState, firstBaseUpdate: null, lastBaseUpdate: null, shared: { pending: null, interleaved: null, lanes: 0 }, effects: null };
  }
  function ss(e, t) {
    e = e.updateQueue, t.updateQueue === e && (t.updateQueue = { baseState: e.baseState, firstBaseUpdate: e.firstBaseUpdate, lastBaseUpdate: e.lastBaseUpdate, shared: e.shared, effects: e.effects });
  }
  function Et(e, t) {
    return { eventTime: e, lane: t, tag: 0, payload: null, callback: null, next: null };
  }
  function At(e, t, n) {
    var r = e.updateQueue;
    if (r === null) return null;
    if (r = r.shared, (G & 2) !== 0) {
      var l = r.pending;
      return l === null ? t.next = t : (t.next = l.next, l.next = t), r.pending = t, xt(e, n);
    }
    return l = r.interleaved, l === null ? (t.next = t, Li(r)) : (t.next = l.next, l.next = t), r.interleaved = t, xt(e, n);
  }
  function el(e, t, n) {
    if (t = t.updateQueue, t !== null && (t = t.shared, (n & 4194240) !== 0)) {
      var r = t.lanes;
      r &= e.pendingLanes, n |= r, t.lanes = n, Yl(e, n);
    }
  }
  function as(e, t) {
    var n = e.updateQueue, r = e.alternate;
    if (r !== null && (r = r.updateQueue, n === r)) {
      var l = null, i = null;
      if (n = n.firstBaseUpdate, n !== null) {
        do {
          var u = { eventTime: n.eventTime, lane: n.lane, tag: n.tag, payload: n.payload, callback: n.callback, next: null };
          i === null ? l = i = u : i = i.next = u, n = n.next;
        } while (n !== null);
        i === null ? l = i = t : i = i.next = t;
      } else l = i = t;
      n = { baseState: r.baseState, firstBaseUpdate: l, lastBaseUpdate: i, shared: r.shared, effects: r.effects }, e.updateQueue = n;
      return;
    }
    e = n.lastBaseUpdate, e === null ? n.firstBaseUpdate = t : e.next = t, n.lastBaseUpdate = t;
  }
  function tl(e, t, n, r) {
    var l = e.updateQueue;
    Ut = !1;
    var i = l.firstBaseUpdate, u = l.lastBaseUpdate, o = l.shared.pending;
    if (o !== null) {
      l.shared.pending = null;
      var a = o, v = a.next;
      a.next = null, u === null ? i = v : u.next = v, u = a;
      var w = e.alternate;
      w !== null && (w = w.updateQueue, o = w.lastBaseUpdate, o !== u && (o === null ? w.firstBaseUpdate = v : o.next = v, w.lastBaseUpdate = a));
    }
    if (i !== null) {
      var k = l.baseState;
      u = 0, w = v = a = null, o = i;
      do {
        var y = o.lane, N = o.eventTime;
        if ((r & y) === y) {
          w !== null && (w = w.next = {
            eventTime: N,
            lane: 0,
            tag: o.tag,
            payload: o.payload,
            callback: o.callback,
            next: null
          });
          e: {
            var j = e, T = o;
            switch (y = t, N = n, T.tag) {
              case 1:
                if (j = T.payload, typeof j == "function") {
                  k = j.call(N, k, y);
                  break e;
                }
                k = j;
                break e;
              case 3:
                j.flags = j.flags & -65537 | 128;
              case 0:
                if (j = T.payload, y = typeof j == "function" ? j.call(N, k, y) : j, y == null) break e;
                k = z({}, k, y);
                break e;
              case 2:
                Ut = !0;
            }
          }
          o.callback !== null && o.lane !== 0 && (e.flags |= 64, y = l.effects, y === null ? l.effects = [o] : y.push(o));
        } else N = { eventTime: N, lane: y, tag: o.tag, payload: o.payload, callback: o.callback, next: null }, w === null ? (v = w = N, a = k) : w = w.next = N, u |= y;
        if (o = o.next, o === null) {
          if (o = l.shared.pending, o === null) break;
          y = o, o = y.next, y.next = null, l.lastBaseUpdate = y, l.shared.pending = null;
        }
      } while (!0);
      if (w === null && (a = k), l.baseState = a, l.firstBaseUpdate = v, l.lastBaseUpdate = w, t = l.shared.interleaved, t !== null) {
        l = t;
        do
          u |= l.lane, l = l.next;
        while (l !== t);
      } else i === null && (l.shared.lanes = 0);
      nn |= u, e.lanes = u, e.memoizedState = k;
    }
  }
  function cs(e, t, n) {
    if (e = t.effects, t.effects = null, e !== null) for (t = 0; t < e.length; t++) {
      var r = e[t], l = r.callback;
      if (l !== null) {
        if (r.callback = null, r = n, typeof l != "function") throw Error(s(191, l));
        l.call(r);
      }
    }
  }
  var ir = {}, mt = Mt(ir), ur = Mt(ir), or = Mt(ir);
  function en(e) {
    if (e === ir) throw Error(s(174));
    return e;
  }
  function Oi(e, t) {
    switch (le(or, t), le(ur, e), le(mt, ir), e = t.nodeType, e) {
      case 9:
      case 11:
        t = (t = t.documentElement) ? t.namespaceURI : Ml(null, "");
        break;
      default:
        e = e === 8 ? t.parentNode : t, t = e.namespaceURI || null, e = e.tagName, t = Ml(t, e);
    }
    ue(mt), le(mt, t);
  }
  function Pn() {
    ue(mt), ue(ur), ue(or);
  }
  function fs(e) {
    en(or.current);
    var t = en(mt.current), n = Ml(t, e.type);
    t !== n && (le(ur, e), le(mt, n));
  }
  function Mi(e) {
    ur.current === e && (ue(mt), ue(ur));
  }
  var ce = Mt(0);
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
  var Ii = [];
  function Fi() {
    for (var e = 0; e < Ii.length; e++) Ii[e]._workInProgressVersionPrimary = null;
    Ii.length = 0;
  }
  var rl = pe.ReactCurrentDispatcher, Ui = pe.ReactCurrentBatchConfig, tn = 0, fe = null, Se = null, Ee = null, ll = !1, sr = !1, ar = 0, nf = 0;
  function Re() {
    throw Error(s(321));
  }
  function Ai(e, t) {
    if (t === null) return !1;
    for (var n = 0; n < t.length && n < e.length; n++) if (!lt(e[n], t[n])) return !1;
    return !0;
  }
  function $i(e, t, n, r, l, i) {
    if (tn = i, fe = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, rl.current = e === null || e.memoizedState === null ? of : sf, e = n(r, l), sr) {
      i = 0;
      do {
        if (sr = !1, ar = 0, 25 <= i) throw Error(s(301));
        i += 1, Ee = Se = null, t.updateQueue = null, rl.current = af, e = n(r, l);
      } while (sr);
    }
    if (rl.current = ol, t = Se !== null && Se.next !== null, tn = 0, Ee = Se = fe = null, ll = !1, t) throw Error(s(300));
    return e;
  }
  function Vi() {
    var e = ar !== 0;
    return ar = 0, e;
  }
  function ht() {
    var e = { memoizedState: null, baseState: null, baseQueue: null, queue: null, next: null };
    return Ee === null ? fe.memoizedState = Ee = e : Ee = Ee.next = e, Ee;
  }
  function be() {
    if (Se === null) {
      var e = fe.alternate;
      e = e !== null ? e.memoizedState : null;
    } else e = Se.next;
    var t = Ee === null ? fe.memoizedState : Ee.next;
    if (t !== null) Ee = t, Se = e;
    else {
      if (e === null) throw Error(s(310));
      Se = e, e = { memoizedState: Se.memoizedState, baseState: Se.baseState, baseQueue: Se.baseQueue, queue: Se.queue, next: null }, Ee === null ? fe.memoizedState = Ee = e : Ee = Ee.next = e;
    }
    return Ee;
  }
  function cr(e, t) {
    return typeof t == "function" ? t(e) : t;
  }
  function Bi(e) {
    var t = be(), n = t.queue;
    if (n === null) throw Error(s(311));
    n.lastRenderedReducer = e;
    var r = Se, l = r.baseQueue, i = n.pending;
    if (i !== null) {
      if (l !== null) {
        var u = l.next;
        l.next = i.next, i.next = u;
      }
      r.baseQueue = l = i, n.pending = null;
    }
    if (l !== null) {
      i = l.next, r = r.baseState;
      var o = u = null, a = null, v = i;
      do {
        var w = v.lane;
        if ((tn & w) === w) a !== null && (a = a.next = { lane: 0, action: v.action, hasEagerState: v.hasEagerState, eagerState: v.eagerState, next: null }), r = v.hasEagerState ? v.eagerState : e(r, v.action);
        else {
          var k = {
            lane: w,
            action: v.action,
            hasEagerState: v.hasEagerState,
            eagerState: v.eagerState,
            next: null
          };
          a === null ? (o = a = k, u = r) : a = a.next = k, fe.lanes |= w, nn |= w;
        }
        v = v.next;
      } while (v !== null && v !== i);
      a === null ? u = r : a.next = o, lt(r, t.memoizedState) || (Ae = !0), t.memoizedState = r, t.baseState = u, t.baseQueue = a, n.lastRenderedState = r;
    }
    if (e = n.interleaved, e !== null) {
      l = e;
      do
        i = l.lane, fe.lanes |= i, nn |= i, l = l.next;
      while (l !== e);
    } else l === null && (n.lanes = 0);
    return [t.memoizedState, n.dispatch];
  }
  function Hi(e) {
    var t = be(), n = t.queue;
    if (n === null) throw Error(s(311));
    n.lastRenderedReducer = e;
    var r = n.dispatch, l = n.pending, i = t.memoizedState;
    if (l !== null) {
      n.pending = null;
      var u = l = l.next;
      do
        i = e(i, u.action), u = u.next;
      while (u !== l);
      lt(i, t.memoizedState) || (Ae = !0), t.memoizedState = i, t.baseQueue === null && (t.baseState = i), n.lastRenderedState = i;
    }
    return [i, r];
  }
  function ds() {
  }
  function ps(e, t) {
    var n = fe, r = be(), l = t(), i = !lt(r.memoizedState, l);
    if (i && (r.memoizedState = l, Ae = !0), r = r.queue, Wi(vs.bind(null, n, r, e), [e]), r.getSnapshot !== t || i || Ee !== null && Ee.memoizedState.tag & 1) {
      if (n.flags |= 2048, fr(9, hs.bind(null, n, r, l, t), void 0, null), Ce === null) throw Error(s(349));
      (tn & 30) !== 0 || ms(n, t, l);
    }
    return l;
  }
  function ms(e, t, n) {
    e.flags |= 16384, e = { getSnapshot: t, value: n }, t = fe.updateQueue, t === null ? (t = { lastEffect: null, stores: null }, fe.updateQueue = t, t.stores = [e]) : (n = t.stores, n === null ? t.stores = [e] : n.push(e));
  }
  function hs(e, t, n, r) {
    t.value = n, t.getSnapshot = r, ys(t) && gs(e);
  }
  function vs(e, t, n) {
    return n(function() {
      ys(t) && gs(e);
    });
  }
  function ys(e) {
    var t = e.getSnapshot;
    e = e.value;
    try {
      var n = t();
      return !lt(e, n);
    } catch {
      return !0;
    }
  }
  function gs(e) {
    var t = xt(e, 1);
    t !== null && at(t, e, 1, -1);
  }
  function ws(e) {
    var t = ht();
    return typeof e == "function" && (e = e()), t.memoizedState = t.baseState = e, e = { pending: null, interleaved: null, lanes: 0, dispatch: null, lastRenderedReducer: cr, lastRenderedState: e }, t.queue = e, e = e.dispatch = uf.bind(null, fe, e), [t.memoizedState, e];
  }
  function fr(e, t, n, r) {
    return e = { tag: e, create: t, destroy: n, deps: r, next: null }, t = fe.updateQueue, t === null ? (t = { lastEffect: null, stores: null }, fe.updateQueue = t, t.lastEffect = e.next = e) : (n = t.lastEffect, n === null ? t.lastEffect = e.next = e : (r = n.next, n.next = e, e.next = r, t.lastEffect = e)), e;
  }
  function ks() {
    return be().memoizedState;
  }
  function il(e, t, n, r) {
    var l = ht();
    fe.flags |= e, l.memoizedState = fr(1 | t, n, void 0, r === void 0 ? null : r);
  }
  function ul(e, t, n, r) {
    var l = be();
    r = r === void 0 ? null : r;
    var i = void 0;
    if (Se !== null) {
      var u = Se.memoizedState;
      if (i = u.destroy, r !== null && Ai(r, u.deps)) {
        l.memoizedState = fr(t, n, i, r);
        return;
      }
    }
    fe.flags |= e, l.memoizedState = fr(1 | t, n, i, r);
  }
  function Ss(e, t) {
    return il(8390656, 8, e, t);
  }
  function Wi(e, t) {
    return ul(2048, 8, e, t);
  }
  function _s(e, t) {
    return ul(4, 2, e, t);
  }
  function xs(e, t) {
    return ul(4, 4, e, t);
  }
  function Es(e, t) {
    if (typeof t == "function") return e = e(), t(e), function() {
      t(null);
    };
    if (t != null) return e = e(), t.current = e, function() {
      t.current = null;
    };
  }
  function Cs(e, t, n) {
    return n = n != null ? n.concat([e]) : null, ul(4, 4, Es.bind(null, t, e), n);
  }
  function Qi() {
  }
  function Ns(e, t) {
    var n = be();
    t = t === void 0 ? null : t;
    var r = n.memoizedState;
    return r !== null && t !== null && Ai(t, r[1]) ? r[0] : (n.memoizedState = [e, t], e);
  }
  function Ps(e, t) {
    var n = be();
    t = t === void 0 ? null : t;
    var r = n.memoizedState;
    return r !== null && t !== null && Ai(t, r[1]) ? r[0] : (e = e(), n.memoizedState = [e, t], e);
  }
  function zs(e, t, n) {
    return (tn & 21) === 0 ? (e.baseState && (e.baseState = !1, Ae = !0), e.memoizedState = n) : (lt(n, t) || (n = ro(), fe.lanes |= n, nn |= n, e.baseState = !0), t);
  }
  function rf(e, t) {
    var n = te;
    te = n !== 0 && 4 > n ? n : 4, e(!0);
    var r = Ui.transition;
    Ui.transition = {};
    try {
      e(!1), t();
    } finally {
      te = n, Ui.transition = r;
    }
  }
  function js() {
    return be().memoizedState;
  }
  function lf(e, t, n) {
    var r = Ht(e);
    if (n = { lane: r, action: n, hasEagerState: !1, eagerState: null, next: null }, Ts(e)) Rs(t, n);
    else if (n = os(e, t, n, r), n !== null) {
      var l = Me();
      at(n, e, r, l), Ls(n, t, r);
    }
  }
  function uf(e, t, n) {
    var r = Ht(e), l = { lane: r, action: n, hasEagerState: !1, eagerState: null, next: null };
    if (Ts(e)) Rs(t, l);
    else {
      var i = e.alternate;
      if (e.lanes === 0 && (i === null || i.lanes === 0) && (i = t.lastRenderedReducer, i !== null)) try {
        var u = t.lastRenderedState, o = i(u, n);
        if (l.hasEagerState = !0, l.eagerState = o, lt(o, u)) {
          var a = t.interleaved;
          a === null ? (l.next = l, Li(t)) : (l.next = a.next, a.next = l), t.interleaved = l;
          return;
        }
      } catch {
      } finally {
      }
      n = os(e, t, l, r), n !== null && (l = Me(), at(n, e, r, l), Ls(n, t, r));
    }
  }
  function Ts(e) {
    var t = e.alternate;
    return e === fe || t !== null && t === fe;
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
  var ol = { readContext: qe, useCallback: Re, useContext: Re, useEffect: Re, useImperativeHandle: Re, useInsertionEffect: Re, useLayoutEffect: Re, useMemo: Re, useReducer: Re, useRef: Re, useState: Re, useDebugValue: Re, useDeferredValue: Re, useTransition: Re, useMutableSource: Re, useSyncExternalStore: Re, useId: Re, unstable_isNewReconciler: !1 }, of = { readContext: qe, useCallback: function(e, t) {
    return ht().memoizedState = [e, t === void 0 ? null : t], e;
  }, useContext: qe, useEffect: Ss, useImperativeHandle: function(e, t, n) {
    return n = n != null ? n.concat([e]) : null, il(
      4194308,
      4,
      Es.bind(null, t, e),
      n
    );
  }, useLayoutEffect: function(e, t) {
    return il(4194308, 4, e, t);
  }, useInsertionEffect: function(e, t) {
    return il(4, 2, e, t);
  }, useMemo: function(e, t) {
    var n = ht();
    return t = t === void 0 ? null : t, e = e(), n.memoizedState = [e, t], e;
  }, useReducer: function(e, t, n) {
    var r = ht();
    return t = n !== void 0 ? n(t) : t, r.memoizedState = r.baseState = t, e = { pending: null, interleaved: null, lanes: 0, dispatch: null, lastRenderedReducer: e, lastRenderedState: t }, r.queue = e, e = e.dispatch = lf.bind(null, fe, e), [r.memoizedState, e];
  }, useRef: function(e) {
    var t = ht();
    return e = { current: e }, t.memoizedState = e;
  }, useState: ws, useDebugValue: Qi, useDeferredValue: function(e) {
    return ht().memoizedState = e;
  }, useTransition: function() {
    var e = ws(!1), t = e[0];
    return e = rf.bind(null, e[1]), ht().memoizedState = e, [t, e];
  }, useMutableSource: function() {
  }, useSyncExternalStore: function(e, t, n) {
    var r = fe, l = ht();
    if (ae) {
      if (n === void 0) throw Error(s(407));
      n = n();
    } else {
      if (n = t(), Ce === null) throw Error(s(349));
      (tn & 30) !== 0 || ms(r, t, n);
    }
    l.memoizedState = n;
    var i = { value: n, getSnapshot: t };
    return l.queue = i, Ss(vs.bind(
      null,
      r,
      i,
      e
    ), [e]), r.flags |= 2048, fr(9, hs.bind(null, r, i, n, t), void 0, null), n;
  }, useId: function() {
    var e = ht(), t = Ce.identifierPrefix;
    if (ae) {
      var n = _t, r = St;
      n = (r & ~(1 << 32 - rt(r) - 1)).toString(32) + n, t = ":" + t + "R" + n, n = ar++, 0 < n && (t += "H" + n.toString(32)), t += ":";
    } else n = nf++, t = ":" + t + "r" + n.toString(32) + ":";
    return e.memoizedState = t;
  }, unstable_isNewReconciler: !1 }, sf = {
    readContext: qe,
    useCallback: Ns,
    useContext: qe,
    useEffect: Wi,
    useImperativeHandle: Cs,
    useInsertionEffect: _s,
    useLayoutEffect: xs,
    useMemo: Ps,
    useReducer: Bi,
    useRef: ks,
    useState: function() {
      return Bi(cr);
    },
    useDebugValue: Qi,
    useDeferredValue: function(e) {
      var t = be();
      return zs(t, Se.memoizedState, e);
    },
    useTransition: function() {
      var e = Bi(cr)[0], t = be().memoizedState;
      return [e, t];
    },
    useMutableSource: ds,
    useSyncExternalStore: ps,
    useId: js,
    unstable_isNewReconciler: !1
  }, af = { readContext: qe, useCallback: Ns, useContext: qe, useEffect: Wi, useImperativeHandle: Cs, useInsertionEffect: _s, useLayoutEffect: xs, useMemo: Ps, useReducer: Hi, useRef: ks, useState: function() {
    return Hi(cr);
  }, useDebugValue: Qi, useDeferredValue: function(e) {
    var t = be();
    return Se === null ? t.memoizedState = e : zs(t, Se.memoizedState, e);
  }, useTransition: function() {
    var e = Hi(cr)[0], t = be().memoizedState;
    return [e, t];
  }, useMutableSource: ds, useSyncExternalStore: ps, useId: js, unstable_isNewReconciler: !1 };
  function ut(e, t) {
    if (e && e.defaultProps) {
      t = z({}, t), e = e.defaultProps;
      for (var n in e) t[n] === void 0 && (t[n] = e[n]);
      return t;
    }
    return t;
  }
  function Ki(e, t, n, r) {
    t = e.memoizedState, n = n(r, t), n = n == null ? t : z({}, t, n), e.memoizedState = n, e.lanes === 0 && (e.updateQueue.baseState = n);
  }
  var sl = { isMounted: function(e) {
    return (e = e._reactInternals) ? Xt(e) === e : !1;
  }, enqueueSetState: function(e, t, n) {
    e = e._reactInternals;
    var r = Me(), l = Ht(e), i = Et(r, l);
    i.payload = t, n != null && (i.callback = n), t = At(e, i, l), t !== null && (at(t, e, l, r), el(t, e, l));
  }, enqueueReplaceState: function(e, t, n) {
    e = e._reactInternals;
    var r = Me(), l = Ht(e), i = Et(r, l);
    i.tag = 1, i.payload = t, n != null && (i.callback = n), t = At(e, i, l), t !== null && (at(t, e, l, r), el(t, e, l));
  }, enqueueForceUpdate: function(e, t) {
    e = e._reactInternals;
    var n = Me(), r = Ht(e), l = Et(n, r);
    l.tag = 2, t != null && (l.callback = t), t = At(e, l, r), t !== null && (at(t, e, r, n), el(t, e, r));
  } };
  function Ds(e, t, n, r, l, i, u) {
    return e = e.stateNode, typeof e.shouldComponentUpdate == "function" ? e.shouldComponentUpdate(r, i, u) : t.prototype && t.prototype.isPureReactComponent ? !Jn(n, r) || !Jn(l, i) : !0;
  }
  function Os(e, t, n) {
    var r = !1, l = It, i = t.contextType;
    return typeof i == "object" && i !== null ? i = qe(i) : (l = Ue(t) ? Zt : Te.current, r = t.contextTypes, i = (r = r != null) ? kn(e, l) : It), t = new t(n, i), e.memoizedState = t.state !== null && t.state !== void 0 ? t.state : null, t.updater = sl, e.stateNode = t, t._reactInternals = e, r && (e = e.stateNode, e.__reactInternalMemoizedUnmaskedChildContext = l, e.__reactInternalMemoizedMaskedChildContext = i), t;
  }
  function Ms(e, t, n, r) {
    e = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(n, r), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(n, r), t.state !== e && sl.enqueueReplaceState(t, t.state, null);
  }
  function Yi(e, t, n, r) {
    var l = e.stateNode;
    l.props = n, l.state = e.memoizedState, l.refs = {}, Di(e);
    var i = t.contextType;
    typeof i == "object" && i !== null ? l.context = qe(i) : (i = Ue(t) ? Zt : Te.current, l.context = kn(e, i)), l.state = e.memoizedState, i = t.getDerivedStateFromProps, typeof i == "function" && (Ki(e, t, i, n), l.state = e.memoizedState), typeof t.getDerivedStateFromProps == "function" || typeof l.getSnapshotBeforeUpdate == "function" || typeof l.UNSAFE_componentWillMount != "function" && typeof l.componentWillMount != "function" || (t = l.state, typeof l.componentWillMount == "function" && l.componentWillMount(), typeof l.UNSAFE_componentWillMount == "function" && l.UNSAFE_componentWillMount(), t !== l.state && sl.enqueueReplaceState(l, l.state, null), tl(e, n, l, r), l.state = e.memoizedState), typeof l.componentDidMount == "function" && (e.flags |= 4194308);
  }
  function zn(e, t) {
    try {
      var n = "", r = t;
      do
        n += Z(r), r = r.return;
      while (r);
      var l = n;
    } catch (i) {
      l = `
Error generating stack: ` + i.message + `
` + i.stack;
    }
    return { value: e, source: t, stack: l, digest: null };
  }
  function Xi(e, t, n) {
    return { value: e, source: null, stack: n ?? null, digest: t ?? null };
  }
  function Gi(e, t) {
    try {
      console.error(t.value);
    } catch (n) {
      setTimeout(function() {
        throw n;
      });
    }
  }
  var cf = typeof WeakMap == "function" ? WeakMap : Map;
  function Is(e, t, n) {
    n = Et(-1, n), n.tag = 3, n.payload = { element: null };
    var r = t.value;
    return n.callback = function() {
      hl || (hl = !0, cu = r), Gi(e, t);
    }, n;
  }
  function Fs(e, t, n) {
    n = Et(-1, n), n.tag = 3;
    var r = e.type.getDerivedStateFromError;
    if (typeof r == "function") {
      var l = t.value;
      n.payload = function() {
        return r(l);
      }, n.callback = function() {
        Gi(e, t);
      };
    }
    var i = e.stateNode;
    return i !== null && typeof i.componentDidCatch == "function" && (n.callback = function() {
      Gi(e, t), typeof r != "function" && (Vt === null ? Vt = /* @__PURE__ */ new Set([this]) : Vt.add(this));
      var u = t.stack;
      this.componentDidCatch(t.value, { componentStack: u !== null ? u : "" });
    }), n;
  }
  function Us(e, t, n) {
    var r = e.pingCache;
    if (r === null) {
      r = e.pingCache = new cf();
      var l = /* @__PURE__ */ new Set();
      r.set(t, l);
    } else l = r.get(t), l === void 0 && (l = /* @__PURE__ */ new Set(), r.set(t, l));
    l.has(n) || (l.add(n), e = Ef.bind(null, e, t, n), t.then(e, e));
  }
  function As(e) {
    do {
      var t;
      if ((t = e.tag === 13) && (t = e.memoizedState, t = t !== null ? t.dehydrated !== null : !0), t) return e;
      e = e.return;
    } while (e !== null);
    return null;
  }
  function $s(e, t, n, r, l) {
    return (e.mode & 1) === 0 ? (e === t ? e.flags |= 65536 : (e.flags |= 128, n.flags |= 131072, n.flags &= -52805, n.tag === 1 && (n.alternate === null ? n.tag = 17 : (t = Et(-1, 1), t.tag = 2, At(n, t, 1))), n.lanes |= 1), e) : (e.flags |= 65536, e.lanes = l, e);
  }
  var ff = pe.ReactCurrentOwner, Ae = !1;
  function Oe(e, t, n, r) {
    t.child = e === null ? us(t, null, n, r) : En(t, e.child, n, r);
  }
  function Vs(e, t, n, r, l) {
    n = n.render;
    var i = t.ref;
    return Nn(t, l), r = $i(e, t, n, r, i, l), n = Vi(), e !== null && !Ae ? (t.updateQueue = e.updateQueue, t.flags &= -2053, e.lanes &= ~l, Ct(e, t, l)) : (ae && n && xi(t), t.flags |= 1, Oe(e, t, r, l), t.child);
  }
  function Bs(e, t, n, r, l) {
    if (e === null) {
      var i = n.type;
      return typeof i == "function" && !yu(i) && i.defaultProps === void 0 && n.compare === null && n.defaultProps === void 0 ? (t.tag = 15, t.type = i, Hs(e, t, i, r, l)) : (e = Sl(n.type, null, r, t, t.mode, l), e.ref = t.ref, e.return = t, t.child = e);
    }
    if (i = e.child, (e.lanes & l) === 0) {
      var u = i.memoizedProps;
      if (n = n.compare, n = n !== null ? n : Jn, n(u, r) && e.ref === t.ref) return Ct(e, t, l);
    }
    return t.flags |= 1, e = Qt(i, r), e.ref = t.ref, e.return = t, t.child = e;
  }
  function Hs(e, t, n, r, l) {
    if (e !== null) {
      var i = e.memoizedProps;
      if (Jn(i, r) && e.ref === t.ref) if (Ae = !1, t.pendingProps = r = i, (e.lanes & l) !== 0) (e.flags & 131072) !== 0 && (Ae = !0);
      else return t.lanes = e.lanes, Ct(e, t, l);
    }
    return Zi(e, t, n, r, l);
  }
  function Ws(e, t, n) {
    var r = t.pendingProps, l = r.children, i = e !== null ? e.memoizedState : null;
    if (r.mode === "hidden") if ((t.mode & 1) === 0) t.memoizedState = { baseLanes: 0, cachePool: null, transitions: null }, le(Tn, Xe), Xe |= n;
    else {
      if ((n & 1073741824) === 0) return e = i !== null ? i.baseLanes | n : n, t.lanes = t.childLanes = 1073741824, t.memoizedState = { baseLanes: e, cachePool: null, transitions: null }, t.updateQueue = null, le(Tn, Xe), Xe |= e, null;
      t.memoizedState = { baseLanes: 0, cachePool: null, transitions: null }, r = i !== null ? i.baseLanes : n, le(Tn, Xe), Xe |= r;
    }
    else i !== null ? (r = i.baseLanes | n, t.memoizedState = null) : r = n, le(Tn, Xe), Xe |= r;
    return Oe(e, t, l, n), t.child;
  }
  function Qs(e, t) {
    var n = t.ref;
    (e === null && n !== null || e !== null && e.ref !== n) && (t.flags |= 512, t.flags |= 2097152);
  }
  function Zi(e, t, n, r, l) {
    var i = Ue(n) ? Zt : Te.current;
    return i = kn(t, i), Nn(t, l), n = $i(e, t, n, r, i, l), r = Vi(), e !== null && !Ae ? (t.updateQueue = e.updateQueue, t.flags &= -2053, e.lanes &= ~l, Ct(e, t, l)) : (ae && r && xi(t), t.flags |= 1, Oe(e, t, n, l), t.child);
  }
  function Ks(e, t, n, r, l) {
    if (Ue(n)) {
      var i = !0;
      Kr(t);
    } else i = !1;
    if (Nn(t, l), t.stateNode === null) cl(e, t), Os(t, n, r), Yi(t, n, r, l), r = !0;
    else if (e === null) {
      var u = t.stateNode, o = t.memoizedProps;
      u.props = o;
      var a = u.context, v = n.contextType;
      typeof v == "object" && v !== null ? v = qe(v) : (v = Ue(n) ? Zt : Te.current, v = kn(t, v));
      var w = n.getDerivedStateFromProps, k = typeof w == "function" || typeof u.getSnapshotBeforeUpdate == "function";
      k || typeof u.UNSAFE_componentWillReceiveProps != "function" && typeof u.componentWillReceiveProps != "function" || (o !== r || a !== v) && Ms(t, u, r, v), Ut = !1;
      var y = t.memoizedState;
      u.state = y, tl(t, r, u, l), a = t.memoizedState, o !== r || y !== a || Fe.current || Ut ? (typeof w == "function" && (Ki(t, n, w, r), a = t.memoizedState), (o = Ut || Ds(t, n, o, r, y, a, v)) ? (k || typeof u.UNSAFE_componentWillMount != "function" && typeof u.componentWillMount != "function" || (typeof u.componentWillMount == "function" && u.componentWillMount(), typeof u.UNSAFE_componentWillMount == "function" && u.UNSAFE_componentWillMount()), typeof u.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof u.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = r, t.memoizedState = a), u.props = r, u.state = a, u.context = v, r = o) : (typeof u.componentDidMount == "function" && (t.flags |= 4194308), r = !1);
    } else {
      u = t.stateNode, ss(e, t), o = t.memoizedProps, v = t.type === t.elementType ? o : ut(t.type, o), u.props = v, k = t.pendingProps, y = u.context, a = n.contextType, typeof a == "object" && a !== null ? a = qe(a) : (a = Ue(n) ? Zt : Te.current, a = kn(t, a));
      var N = n.getDerivedStateFromProps;
      (w = typeof N == "function" || typeof u.getSnapshotBeforeUpdate == "function") || typeof u.UNSAFE_componentWillReceiveProps != "function" && typeof u.componentWillReceiveProps != "function" || (o !== k || y !== a) && Ms(t, u, r, a), Ut = !1, y = t.memoizedState, u.state = y, tl(t, r, u, l);
      var j = t.memoizedState;
      o !== k || y !== j || Fe.current || Ut ? (typeof N == "function" && (Ki(t, n, N, r), j = t.memoizedState), (v = Ut || Ds(t, n, v, r, y, j, a) || !1) ? (w || typeof u.UNSAFE_componentWillUpdate != "function" && typeof u.componentWillUpdate != "function" || (typeof u.componentWillUpdate == "function" && u.componentWillUpdate(r, j, a), typeof u.UNSAFE_componentWillUpdate == "function" && u.UNSAFE_componentWillUpdate(r, j, a)), typeof u.componentDidUpdate == "function" && (t.flags |= 4), typeof u.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof u.componentDidUpdate != "function" || o === e.memoizedProps && y === e.memoizedState || (t.flags |= 4), typeof u.getSnapshotBeforeUpdate != "function" || o === e.memoizedProps && y === e.memoizedState || (t.flags |= 1024), t.memoizedProps = r, t.memoizedState = j), u.props = r, u.state = j, u.context = a, r = v) : (typeof u.componentDidUpdate != "function" || o === e.memoizedProps && y === e.memoizedState || (t.flags |= 4), typeof u.getSnapshotBeforeUpdate != "function" || o === e.memoizedProps && y === e.memoizedState || (t.flags |= 1024), r = !1);
    }
    return Ji(e, t, n, r, i, l);
  }
  function Ji(e, t, n, r, l, i) {
    Qs(e, t);
    var u = (t.flags & 128) !== 0;
    if (!r && !u) return l && Jo(t, n, !1), Ct(e, t, i);
    r = t.stateNode, ff.current = t;
    var o = u && typeof n.getDerivedStateFromError != "function" ? null : r.render();
    return t.flags |= 1, e !== null && u ? (t.child = En(t, e.child, null, i), t.child = En(t, null, o, i)) : Oe(e, t, o, i), t.memoizedState = r.state, l && Jo(t, n, !0), t.child;
  }
  function Ys(e) {
    var t = e.stateNode;
    t.pendingContext ? Go(e, t.pendingContext, t.pendingContext !== t.context) : t.context && Go(e, t.context, !1), Oi(e, t.containerInfo);
  }
  function Xs(e, t, n, r, l) {
    return xn(), Pi(l), t.flags |= 256, Oe(e, t, n, r), t.child;
  }
  var qi = { dehydrated: null, treeContext: null, retryLane: 0 };
  function bi(e) {
    return { baseLanes: e, cachePool: null, transitions: null };
  }
  function Gs(e, t, n) {
    var r = t.pendingProps, l = ce.current, i = !1, u = (t.flags & 128) !== 0, o;
    if ((o = u) || (o = e !== null && e.memoizedState === null ? !1 : (l & 2) !== 0), o ? (i = !0, t.flags &= -129) : (e === null || e.memoizedState !== null) && (l |= 1), le(ce, l & 1), e === null)
      return Ni(t), e = t.memoizedState, e !== null && (e = e.dehydrated, e !== null) ? ((t.mode & 1) === 0 ? t.lanes = 1 : e.data === "$!" ? t.lanes = 8 : t.lanes = 1073741824, null) : (u = r.children, e = r.fallback, i ? (r = t.mode, i = t.child, u = { mode: "hidden", children: u }, (r & 1) === 0 && i !== null ? (i.childLanes = 0, i.pendingProps = u) : i = _l(u, r, 0, null), e = on(e, r, n, null), i.return = t, e.return = t, i.sibling = e, t.child = i, t.child.memoizedState = bi(n), t.memoizedState = qi, e) : eu(t, u));
    if (l = e.memoizedState, l !== null && (o = l.dehydrated, o !== null)) return df(e, t, u, r, o, l, n);
    if (i) {
      i = r.fallback, u = t.mode, l = e.child, o = l.sibling;
      var a = { mode: "hidden", children: r.children };
      return (u & 1) === 0 && t.child !== l ? (r = t.child, r.childLanes = 0, r.pendingProps = a, t.deletions = null) : (r = Qt(l, a), r.subtreeFlags = l.subtreeFlags & 14680064), o !== null ? i = Qt(o, i) : (i = on(i, u, n, null), i.flags |= 2), i.return = t, r.return = t, r.sibling = i, t.child = r, r = i, i = t.child, u = e.child.memoizedState, u = u === null ? bi(n) : { baseLanes: u.baseLanes | n, cachePool: null, transitions: u.transitions }, i.memoizedState = u, i.childLanes = e.childLanes & ~n, t.memoizedState = qi, r;
    }
    return i = e.child, e = i.sibling, r = Qt(i, { mode: "visible", children: r.children }), (t.mode & 1) === 0 && (r.lanes = n), r.return = t, r.sibling = null, e !== null && (n = t.deletions, n === null ? (t.deletions = [e], t.flags |= 16) : n.push(e)), t.child = r, t.memoizedState = null, r;
  }
  function eu(e, t) {
    return t = _l({ mode: "visible", children: t }, e.mode, 0, null), t.return = e, e.child = t;
  }
  function al(e, t, n, r) {
    return r !== null && Pi(r), En(t, e.child, null, n), e = eu(t, t.pendingProps.children), e.flags |= 2, t.memoizedState = null, e;
  }
  function df(e, t, n, r, l, i, u) {
    if (n)
      return t.flags & 256 ? (t.flags &= -257, r = Xi(Error(s(422))), al(e, t, u, r)) : t.memoizedState !== null ? (t.child = e.child, t.flags |= 128, null) : (i = r.fallback, l = t.mode, r = _l({ mode: "visible", children: r.children }, l, 0, null), i = on(i, l, u, null), i.flags |= 2, r.return = t, i.return = t, r.sibling = i, t.child = r, (t.mode & 1) !== 0 && En(t, e.child, null, u), t.child.memoizedState = bi(u), t.memoizedState = qi, i);
    if ((t.mode & 1) === 0) return al(e, t, u, null);
    if (l.data === "$!") {
      if (r = l.nextSibling && l.nextSibling.dataset, r) var o = r.dgst;
      return r = o, i = Error(s(419)), r = Xi(i, r, void 0), al(e, t, u, r);
    }
    if (o = (u & e.childLanes) !== 0, Ae || o) {
      if (r = Ce, r !== null) {
        switch (u & -u) {
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
        l = (l & (r.suspendedLanes | u)) !== 0 ? 0 : l, l !== 0 && l !== i.retryLane && (i.retryLane = l, xt(e, l), at(r, e, l, -1));
      }
      return vu(), r = Xi(Error(s(421))), al(e, t, u, r);
    }
    return l.data === "$?" ? (t.flags |= 128, t.child = e.child, t = Cf.bind(null, e), l._reactRetry = t, null) : (e = i.treeContext, Ye = Ot(l.nextSibling), Ke = t, ae = !0, it = null, e !== null && (Ze[Je++] = St, Ze[Je++] = _t, Ze[Je++] = Jt, St = e.id, _t = e.overflow, Jt = t), t = eu(t, r.children), t.flags |= 4096, t);
  }
  function Zs(e, t, n) {
    e.lanes |= t;
    var r = e.alternate;
    r !== null && (r.lanes |= t), Ri(e.return, t, n);
  }
  function tu(e, t, n, r, l) {
    var i = e.memoizedState;
    i === null ? e.memoizedState = { isBackwards: t, rendering: null, renderingStartTime: 0, last: r, tail: n, tailMode: l } : (i.isBackwards = t, i.rendering = null, i.renderingStartTime = 0, i.last = r, i.tail = n, i.tailMode = l);
  }
  function Js(e, t, n) {
    var r = t.pendingProps, l = r.revealOrder, i = r.tail;
    if (Oe(e, t, r.children, n), r = ce.current, (r & 2) !== 0) r = r & 1 | 2, t.flags |= 128;
    else {
      if (e !== null && (e.flags & 128) !== 0) e: for (e = t.child; e !== null; ) {
        if (e.tag === 13) e.memoizedState !== null && Zs(e, n, t);
        else if (e.tag === 19) Zs(e, n, t);
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
    if (le(ce, r), (t.mode & 1) === 0) t.memoizedState = null;
    else switch (l) {
      case "forwards":
        for (n = t.child, l = null; n !== null; ) e = n.alternate, e !== null && nl(e) === null && (l = n), n = n.sibling;
        n = l, n === null ? (l = t.child, t.child = null) : (l = n.sibling, n.sibling = null), tu(t, !1, l, n, i);
        break;
      case "backwards":
        for (n = null, l = t.child, t.child = null; l !== null; ) {
          if (e = l.alternate, e !== null && nl(e) === null) {
            t.child = l;
            break;
          }
          e = l.sibling, l.sibling = n, n = l, l = e;
        }
        tu(t, !0, n, null, i);
        break;
      case "together":
        tu(t, !1, null, null, void 0);
        break;
      default:
        t.memoizedState = null;
    }
    return t.child;
  }
  function cl(e, t) {
    (t.mode & 1) === 0 && e !== null && (e.alternate = null, t.alternate = null, t.flags |= 2);
  }
  function Ct(e, t, n) {
    if (e !== null && (t.dependencies = e.dependencies), nn |= t.lanes, (n & t.childLanes) === 0) return null;
    if (e !== null && t.child !== e.child) throw Error(s(153));
    if (t.child !== null) {
      for (e = t.child, n = Qt(e, e.pendingProps), t.child = n, n.return = t; e.sibling !== null; ) e = e.sibling, n = n.sibling = Qt(e, e.pendingProps), n.return = t;
      n.sibling = null;
    }
    return t.child;
  }
  function pf(e, t, n) {
    switch (t.tag) {
      case 3:
        Ys(t), xn();
        break;
      case 5:
        fs(t);
        break;
      case 1:
        Ue(t.type) && Kr(t);
        break;
      case 4:
        Oi(t, t.stateNode.containerInfo);
        break;
      case 10:
        var r = t.type._context, l = t.memoizedProps.value;
        le(qr, r._currentValue), r._currentValue = l;
        break;
      case 13:
        if (r = t.memoizedState, r !== null)
          return r.dehydrated !== null ? (le(ce, ce.current & 1), t.flags |= 128, null) : (n & t.child.childLanes) !== 0 ? Gs(e, t, n) : (le(ce, ce.current & 1), e = Ct(e, t, n), e !== null ? e.sibling : null);
        le(ce, ce.current & 1);
        break;
      case 19:
        if (r = (n & t.childLanes) !== 0, (e.flags & 128) !== 0) {
          if (r) return Js(e, t, n);
          t.flags |= 128;
        }
        if (l = t.memoizedState, l !== null && (l.rendering = null, l.tail = null, l.lastEffect = null), le(ce, ce.current), r) break;
        return null;
      case 22:
      case 23:
        return t.lanes = 0, Ws(e, t, n);
    }
    return Ct(e, t, n);
  }
  var qs, nu, bs, ea;
  qs = function(e, t) {
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
  }, nu = function() {
  }, bs = function(e, t, n, r) {
    var l = e.memoizedProps;
    if (l !== r) {
      e = t.stateNode, en(mt.current);
      var i = null;
      switch (n) {
        case "input":
          l = Rl(e, l), r = Rl(e, r), i = [];
          break;
        case "select":
          l = z({}, l, { value: void 0 }), r = z({}, r, { value: void 0 }), i = [];
          break;
        case "textarea":
          l = Ol(e, l), r = Ol(e, r), i = [];
          break;
        default:
          typeof l.onClick != "function" && typeof r.onClick == "function" && (e.onclick = Hr);
      }
      Il(n, r);
      var u;
      n = null;
      for (v in l) if (!r.hasOwnProperty(v) && l.hasOwnProperty(v) && l[v] != null) if (v === "style") {
        var o = l[v];
        for (u in o) o.hasOwnProperty(u) && (n || (n = {}), n[u] = "");
      } else v !== "dangerouslySetInnerHTML" && v !== "children" && v !== "suppressContentEditableWarning" && v !== "suppressHydrationWarning" && v !== "autoFocus" && (x.hasOwnProperty(v) ? i || (i = []) : (i = i || []).push(v, null));
      for (v in r) {
        var a = r[v];
        if (o = l != null ? l[v] : void 0, r.hasOwnProperty(v) && a !== o && (a != null || o != null)) if (v === "style") if (o) {
          for (u in o) !o.hasOwnProperty(u) || a && a.hasOwnProperty(u) || (n || (n = {}), n[u] = "");
          for (u in a) a.hasOwnProperty(u) && o[u] !== a[u] && (n || (n = {}), n[u] = a[u]);
        } else n || (i || (i = []), i.push(
          v,
          n
        )), n = a;
        else v === "dangerouslySetInnerHTML" ? (a = a ? a.__html : void 0, o = o ? o.__html : void 0, a != null && o !== a && (i = i || []).push(v, a)) : v === "children" ? typeof a != "string" && typeof a != "number" || (i = i || []).push(v, "" + a) : v !== "suppressContentEditableWarning" && v !== "suppressHydrationWarning" && (x.hasOwnProperty(v) ? (a != null && v === "onScroll" && ie("scroll", e), i || o === a || (i = [])) : (i = i || []).push(v, a));
      }
      n && (i = i || []).push("style", n);
      var v = i;
      (t.updateQueue = v) && (t.flags |= 4);
    }
  }, ea = function(e, t, n, r) {
    n !== r && (t.flags |= 4);
  };
  function dr(e, t) {
    if (!ae) switch (e.tailMode) {
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
  function Le(e) {
    var t = e.alternate !== null && e.alternate.child === e.child, n = 0, r = 0;
    if (t) for (var l = e.child; l !== null; ) n |= l.lanes | l.childLanes, r |= l.subtreeFlags & 14680064, r |= l.flags & 14680064, l.return = e, l = l.sibling;
    else for (l = e.child; l !== null; ) n |= l.lanes | l.childLanes, r |= l.subtreeFlags, r |= l.flags, l.return = e, l = l.sibling;
    return e.subtreeFlags |= r, e.childLanes = n, t;
  }
  function mf(e, t, n) {
    var r = t.pendingProps;
    switch (Ei(t), t.tag) {
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
        return Le(t), null;
      case 1:
        return Ue(t.type) && Qr(), Le(t), null;
      case 3:
        return r = t.stateNode, Pn(), ue(Fe), ue(Te), Fi(), r.pendingContext && (r.context = r.pendingContext, r.pendingContext = null), (e === null || e.child === null) && (Zr(t) ? t.flags |= 4 : e === null || e.memoizedState.isDehydrated && (t.flags & 256) === 0 || (t.flags |= 1024, it !== null && (pu(it), it = null))), nu(e, t), Le(t), null;
      case 5:
        Mi(t);
        var l = en(or.current);
        if (n = t.type, e !== null && t.stateNode != null) bs(e, t, n, r, l), e.ref !== t.ref && (t.flags |= 512, t.flags |= 2097152);
        else {
          if (!r) {
            if (t.stateNode === null) throw Error(s(166));
            return Le(t), null;
          }
          if (e = en(mt.current), Zr(t)) {
            r = t.stateNode, n = t.type;
            var i = t.memoizedProps;
            switch (r[pt] = t, r[nr] = i, e = (t.mode & 1) !== 0, n) {
              case "dialog":
                ie("cancel", r), ie("close", r);
                break;
              case "iframe":
              case "object":
              case "embed":
                ie("load", r);
                break;
              case "video":
              case "audio":
                for (l = 0; l < bn.length; l++) ie(bn[l], r);
                break;
              case "source":
                ie("error", r);
                break;
              case "img":
              case "image":
              case "link":
                ie(
                  "error",
                  r
                ), ie("load", r);
                break;
              case "details":
                ie("toggle", r);
                break;
              case "input":
                Du(r, i), ie("invalid", r);
                break;
              case "select":
                r._wrapperState = { wasMultiple: !!i.multiple }, ie("invalid", r);
                break;
              case "textarea":
                Iu(r, i), ie("invalid", r);
            }
            Il(n, i), l = null;
            for (var u in i) if (i.hasOwnProperty(u)) {
              var o = i[u];
              u === "children" ? typeof o == "string" ? r.textContent !== o && (i.suppressHydrationWarning !== !0 && Br(r.textContent, o, e), l = ["children", o]) : typeof o == "number" && r.textContent !== "" + o && (i.suppressHydrationWarning !== !0 && Br(
                r.textContent,
                o,
                e
              ), l = ["children", "" + o]) : x.hasOwnProperty(u) && o != null && u === "onScroll" && ie("scroll", r);
            }
            switch (n) {
              case "input":
                wr(r), Mu(r, i, !0);
                break;
              case "textarea":
                wr(r), Uu(r);
                break;
              case "select":
              case "option":
                break;
              default:
                typeof i.onClick == "function" && (r.onclick = Hr);
            }
            r = l, t.updateQueue = r, r !== null && (t.flags |= 4);
          } else {
            u = l.nodeType === 9 ? l : l.ownerDocument, e === "http://www.w3.org/1999/xhtml" && (e = Au(n)), e === "http://www.w3.org/1999/xhtml" ? n === "script" ? (e = u.createElement("div"), e.innerHTML = "<script><\/script>", e = e.removeChild(e.firstChild)) : typeof r.is == "string" ? e = u.createElement(n, { is: r.is }) : (e = u.createElement(n), n === "select" && (u = e, r.multiple ? u.multiple = !0 : r.size && (u.size = r.size))) : e = u.createElementNS(e, n), e[pt] = t, e[nr] = r, qs(e, t, !1, !1), t.stateNode = e;
            e: {
              switch (u = Fl(n, r), n) {
                case "dialog":
                  ie("cancel", e), ie("close", e), l = r;
                  break;
                case "iframe":
                case "object":
                case "embed":
                  ie("load", e), l = r;
                  break;
                case "video":
                case "audio":
                  for (l = 0; l < bn.length; l++) ie(bn[l], e);
                  l = r;
                  break;
                case "source":
                  ie("error", e), l = r;
                  break;
                case "img":
                case "image":
                case "link":
                  ie(
                    "error",
                    e
                  ), ie("load", e), l = r;
                  break;
                case "details":
                  ie("toggle", e), l = r;
                  break;
                case "input":
                  Du(e, r), l = Rl(e, r), ie("invalid", e);
                  break;
                case "option":
                  l = r;
                  break;
                case "select":
                  e._wrapperState = { wasMultiple: !!r.multiple }, l = z({}, r, { value: void 0 }), ie("invalid", e);
                  break;
                case "textarea":
                  Iu(e, r), l = Ol(e, r), ie("invalid", e);
                  break;
                default:
                  l = r;
              }
              Il(n, l), o = l;
              for (i in o) if (o.hasOwnProperty(i)) {
                var a = o[i];
                i === "style" ? Bu(e, a) : i === "dangerouslySetInnerHTML" ? (a = a ? a.__html : void 0, a != null && $u(e, a)) : i === "children" ? typeof a == "string" ? (n !== "textarea" || a !== "") && On(e, a) : typeof a == "number" && On(e, "" + a) : i !== "suppressContentEditableWarning" && i !== "suppressHydrationWarning" && i !== "autoFocus" && (x.hasOwnProperty(i) ? a != null && i === "onScroll" && ie("scroll", e) : a != null && de(e, i, a, u));
              }
              switch (n) {
                case "input":
                  wr(e), Mu(e, r, !1);
                  break;
                case "textarea":
                  wr(e), Uu(e);
                  break;
                case "option":
                  r.value != null && e.setAttribute("value", "" + ee(r.value));
                  break;
                case "select":
                  e.multiple = !!r.multiple, i = r.value, i != null ? sn(e, !!r.multiple, i, !1) : r.defaultValue != null && sn(
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
        return Le(t), null;
      case 6:
        if (e && t.stateNode != null) ea(e, t, e.memoizedProps, r);
        else {
          if (typeof r != "string" && t.stateNode === null) throw Error(s(166));
          if (n = en(or.current), en(mt.current), Zr(t)) {
            if (r = t.stateNode, n = t.memoizedProps, r[pt] = t, (i = r.nodeValue !== n) && (e = Ke, e !== null)) switch (e.tag) {
              case 3:
                Br(r.nodeValue, n, (e.mode & 1) !== 0);
                break;
              case 5:
                e.memoizedProps.suppressHydrationWarning !== !0 && Br(r.nodeValue, n, (e.mode & 1) !== 0);
            }
            i && (t.flags |= 4);
          } else r = (n.nodeType === 9 ? n : n.ownerDocument).createTextNode(r), r[pt] = t, t.stateNode = r;
        }
        return Le(t), null;
      case 13:
        if (ue(ce), r = t.memoizedState, e === null || e.memoizedState !== null && e.memoizedState.dehydrated !== null) {
          if (ae && Ye !== null && (t.mode & 1) !== 0 && (t.flags & 128) === 0) rs(), xn(), t.flags |= 98560, i = !1;
          else if (i = Zr(t), r !== null && r.dehydrated !== null) {
            if (e === null) {
              if (!i) throw Error(s(318));
              if (i = t.memoizedState, i = i !== null ? i.dehydrated : null, !i) throw Error(s(317));
              i[pt] = t;
            } else xn(), (t.flags & 128) === 0 && (t.memoizedState = null), t.flags |= 4;
            Le(t), i = !1;
          } else it !== null && (pu(it), it = null), i = !0;
          if (!i) return t.flags & 65536 ? t : null;
        }
        return (t.flags & 128) !== 0 ? (t.lanes = n, t) : (r = r !== null, r !== (e !== null && e.memoizedState !== null) && r && (t.child.flags |= 8192, (t.mode & 1) !== 0 && (e === null || (ce.current & 1) !== 0 ? _e === 0 && (_e = 3) : vu())), t.updateQueue !== null && (t.flags |= 4), Le(t), null);
      case 4:
        return Pn(), nu(e, t), e === null && er(t.stateNode.containerInfo), Le(t), null;
      case 10:
        return Ti(t.type._context), Le(t), null;
      case 17:
        return Ue(t.type) && Qr(), Le(t), null;
      case 19:
        if (ue(ce), i = t.memoizedState, i === null) return Le(t), null;
        if (r = (t.flags & 128) !== 0, u = i.rendering, u === null) if (r) dr(i, !1);
        else {
          if (_e !== 0 || e !== null && (e.flags & 128) !== 0) for (e = t.child; e !== null; ) {
            if (u = nl(e), u !== null) {
              for (t.flags |= 128, dr(i, !1), r = u.updateQueue, r !== null && (t.updateQueue = r, t.flags |= 4), t.subtreeFlags = 0, r = n, n = t.child; n !== null; ) i = n, e = r, i.flags &= 14680066, u = i.alternate, u === null ? (i.childLanes = 0, i.lanes = e, i.child = null, i.subtreeFlags = 0, i.memoizedProps = null, i.memoizedState = null, i.updateQueue = null, i.dependencies = null, i.stateNode = null) : (i.childLanes = u.childLanes, i.lanes = u.lanes, i.child = u.child, i.subtreeFlags = 0, i.deletions = null, i.memoizedProps = u.memoizedProps, i.memoizedState = u.memoizedState, i.updateQueue = u.updateQueue, i.type = u.type, e = u.dependencies, i.dependencies = e === null ? null : { lanes: e.lanes, firstContext: e.firstContext }), n = n.sibling;
              return le(ce, ce.current & 1 | 2), t.child;
            }
            e = e.sibling;
          }
          i.tail !== null && ye() > Rn && (t.flags |= 128, r = !0, dr(i, !1), t.lanes = 4194304);
        }
        else {
          if (!r) if (e = nl(u), e !== null) {
            if (t.flags |= 128, r = !0, n = e.updateQueue, n !== null && (t.updateQueue = n, t.flags |= 4), dr(i, !0), i.tail === null && i.tailMode === "hidden" && !u.alternate && !ae) return Le(t), null;
          } else 2 * ye() - i.renderingStartTime > Rn && n !== 1073741824 && (t.flags |= 128, r = !0, dr(i, !1), t.lanes = 4194304);
          i.isBackwards ? (u.sibling = t.child, t.child = u) : (n = i.last, n !== null ? n.sibling = u : t.child = u, i.last = u);
        }
        return i.tail !== null ? (t = i.tail, i.rendering = t, i.tail = t.sibling, i.renderingStartTime = ye(), t.sibling = null, n = ce.current, le(ce, r ? n & 1 | 2 : n & 1), t) : (Le(t), null);
      case 22:
      case 23:
        return hu(), r = t.memoizedState !== null, e !== null && e.memoizedState !== null !== r && (t.flags |= 8192), r && (t.mode & 1) !== 0 ? (Xe & 1073741824) !== 0 && (Le(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : Le(t), null;
      case 24:
        return null;
      case 25:
        return null;
    }
    throw Error(s(156, t.tag));
  }
  function hf(e, t) {
    switch (Ei(t), t.tag) {
      case 1:
        return Ue(t.type) && Qr(), e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
      case 3:
        return Pn(), ue(Fe), ue(Te), Fi(), e = t.flags, (e & 65536) !== 0 && (e & 128) === 0 ? (t.flags = e & -65537 | 128, t) : null;
      case 5:
        return Mi(t), null;
      case 13:
        if (ue(ce), e = t.memoizedState, e !== null && e.dehydrated !== null) {
          if (t.alternate === null) throw Error(s(340));
          xn();
        }
        return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
      case 19:
        return ue(ce), null;
      case 4:
        return Pn(), null;
      case 10:
        return Ti(t.type._context), null;
      case 22:
      case 23:
        return hu(), null;
      case 24:
        return null;
      default:
        return null;
    }
  }
  var fl = !1, De = !1, vf = typeof WeakSet == "function" ? WeakSet : Set, P = null;
  function jn(e, t) {
    var n = e.ref;
    if (n !== null) if (typeof n == "function") try {
      n(null);
    } catch (r) {
      he(e, t, r);
    }
    else n.current = null;
  }
  function ru(e, t, n) {
    try {
      n();
    } catch (r) {
      he(e, t, r);
    }
  }
  var ta = !1;
  function yf(e, t) {
    if (hi = Rr, e = Do(), oi(e)) {
      if ("selectionStart" in e) var n = { start: e.selectionStart, end: e.selectionEnd };
      else e: {
        n = (n = e.ownerDocument) && n.defaultView || window;
        var r = n.getSelection && n.getSelection();
        if (r && r.rangeCount !== 0) {
          n = r.anchorNode;
          var l = r.anchorOffset, i = r.focusNode;
          r = r.focusOffset;
          try {
            n.nodeType, i.nodeType;
          } catch {
            n = null;
            break e;
          }
          var u = 0, o = -1, a = -1, v = 0, w = 0, k = e, y = null;
          t: for (; ; ) {
            for (var N; k !== n || l !== 0 && k.nodeType !== 3 || (o = u + l), k !== i || r !== 0 && k.nodeType !== 3 || (a = u + r), k.nodeType === 3 && (u += k.nodeValue.length), (N = k.firstChild) !== null; )
              y = k, k = N;
            for (; ; ) {
              if (k === e) break t;
              if (y === n && ++v === l && (o = u), y === i && ++w === r && (a = u), (N = k.nextSibling) !== null) break;
              k = y, y = k.parentNode;
            }
            k = N;
          }
          n = o === -1 || a === -1 ? null : { start: o, end: a };
        } else n = null;
      }
      n = n || { start: 0, end: 0 };
    } else n = null;
    for (vi = { focusedElem: e, selectionRange: n }, Rr = !1, P = t; P !== null; ) if (t = P, e = t.child, (t.subtreeFlags & 1028) !== 0 && e !== null) e.return = t, P = e;
    else for (; P !== null; ) {
      t = P;
      try {
        var j = t.alternate;
        if ((t.flags & 1024) !== 0) switch (t.tag) {
          case 0:
          case 11:
          case 15:
            break;
          case 1:
            if (j !== null) {
              var T = j.memoizedProps, ge = j.memoizedState, m = t.stateNode, c = m.getSnapshotBeforeUpdate(t.elementType === t.type ? T : ut(t.type, T), ge);
              m.__reactInternalSnapshotBeforeUpdate = c;
            }
            break;
          case 3:
            var h = t.stateNode.containerInfo;
            h.nodeType === 1 ? h.textContent = "" : h.nodeType === 9 && h.documentElement && h.removeChild(h.documentElement);
            break;
          case 5:
          case 6:
          case 4:
          case 17:
            break;
          default:
            throw Error(s(163));
        }
      } catch (S) {
        he(t, t.return, S);
      }
      if (e = t.sibling, e !== null) {
        e.return = t.return, P = e;
        break;
      }
      P = t.return;
    }
    return j = ta, ta = !1, j;
  }
  function pr(e, t, n) {
    var r = t.updateQueue;
    if (r = r !== null ? r.lastEffect : null, r !== null) {
      var l = r = r.next;
      do {
        if ((l.tag & e) === e) {
          var i = l.destroy;
          l.destroy = void 0, i !== void 0 && ru(t, n, i);
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
  function lu(e) {
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
  function na(e) {
    var t = e.alternate;
    t !== null && (e.alternate = null, na(t)), e.child = null, e.deletions = null, e.sibling = null, e.tag === 5 && (t = e.stateNode, t !== null && (delete t[pt], delete t[nr], delete t[ki], delete t[qc], delete t[bc])), e.stateNode = null, e.return = null, e.dependencies = null, e.memoizedProps = null, e.memoizedState = null, e.pendingProps = null, e.stateNode = null, e.updateQueue = null;
  }
  function ra(e) {
    return e.tag === 5 || e.tag === 3 || e.tag === 4;
  }
  function la(e) {
    e: for (; ; ) {
      for (; e.sibling === null; ) {
        if (e.return === null || ra(e.return)) return null;
        e = e.return;
      }
      for (e.sibling.return = e.return, e = e.sibling; e.tag !== 5 && e.tag !== 6 && e.tag !== 18; ) {
        if (e.flags & 2 || e.child === null || e.tag === 4) continue e;
        e.child.return = e, e = e.child;
      }
      if (!(e.flags & 2)) return e.stateNode;
    }
  }
  function iu(e, t, n) {
    var r = e.tag;
    if (r === 5 || r === 6) e = e.stateNode, t ? n.nodeType === 8 ? n.parentNode.insertBefore(e, t) : n.insertBefore(e, t) : (n.nodeType === 8 ? (t = n.parentNode, t.insertBefore(e, n)) : (t = n, t.appendChild(e)), n = n._reactRootContainer, n != null || t.onclick !== null || (t.onclick = Hr));
    else if (r !== 4 && (e = e.child, e !== null)) for (iu(e, t, n), e = e.sibling; e !== null; ) iu(e, t, n), e = e.sibling;
  }
  function uu(e, t, n) {
    var r = e.tag;
    if (r === 5 || r === 6) e = e.stateNode, t ? n.insertBefore(e, t) : n.appendChild(e);
    else if (r !== 4 && (e = e.child, e !== null)) for (uu(e, t, n), e = e.sibling; e !== null; ) uu(e, t, n), e = e.sibling;
  }
  var ze = null, ot = !1;
  function $t(e, t, n) {
    for (n = n.child; n !== null; ) ia(e, t, n), n = n.sibling;
  }
  function ia(e, t, n) {
    if (dt && typeof dt.onCommitFiberUnmount == "function") try {
      dt.onCommitFiberUnmount(Cr, n);
    } catch {
    }
    switch (n.tag) {
      case 5:
        De || jn(n, t);
      case 6:
        var r = ze, l = ot;
        ze = null, $t(e, t, n), ze = r, ot = l, ze !== null && (ot ? (e = ze, n = n.stateNode, e.nodeType === 8 ? e.parentNode.removeChild(n) : e.removeChild(n)) : ze.removeChild(n.stateNode));
        break;
      case 18:
        ze !== null && (ot ? (e = ze, n = n.stateNode, e.nodeType === 8 ? wi(e.parentNode, n) : e.nodeType === 1 && wi(e, n), Qn(e)) : wi(ze, n.stateNode));
        break;
      case 4:
        r = ze, l = ot, ze = n.stateNode.containerInfo, ot = !0, $t(e, t, n), ze = r, ot = l;
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        if (!De && (r = n.updateQueue, r !== null && (r = r.lastEffect, r !== null))) {
          l = r = r.next;
          do {
            var i = l, u = i.destroy;
            i = i.tag, u !== void 0 && ((i & 2) !== 0 || (i & 4) !== 0) && ru(n, t, u), l = l.next;
          } while (l !== r);
        }
        $t(e, t, n);
        break;
      case 1:
        if (!De && (jn(n, t), r = n.stateNode, typeof r.componentWillUnmount == "function")) try {
          r.props = n.memoizedProps, r.state = n.memoizedState, r.componentWillUnmount();
        } catch (o) {
          he(n, t, o);
        }
        $t(e, t, n);
        break;
      case 21:
        $t(e, t, n);
        break;
      case 22:
        n.mode & 1 ? (De = (r = De) || n.memoizedState !== null, $t(e, t, n), De = r) : $t(e, t, n);
        break;
      default:
        $t(e, t, n);
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
        var i = e, u = t, o = u;
        e: for (; o !== null; ) {
          switch (o.tag) {
            case 5:
              ze = o.stateNode, ot = !1;
              break e;
            case 3:
              ze = o.stateNode.containerInfo, ot = !0;
              break e;
            case 4:
              ze = o.stateNode.containerInfo, ot = !0;
              break e;
          }
          o = o.return;
        }
        if (ze === null) throw Error(s(160));
        ia(i, u, l), ze = null, ot = !1;
        var a = l.alternate;
        a !== null && (a.return = null), l.return = null;
      } catch (v) {
        he(l, t, v);
      }
    }
    if (t.subtreeFlags & 12854) for (t = t.child; t !== null; ) oa(t, e), t = t.sibling;
  }
  function oa(e, t) {
    var n = e.alternate, r = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        if (st(t, e), vt(e), r & 4) {
          try {
            pr(3, e, e.return), dl(3, e);
          } catch (T) {
            he(e, e.return, T);
          }
          try {
            pr(5, e, e.return);
          } catch (T) {
            he(e, e.return, T);
          }
        }
        break;
      case 1:
        st(t, e), vt(e), r & 512 && n !== null && jn(n, n.return);
        break;
      case 5:
        if (st(t, e), vt(e), r & 512 && n !== null && jn(n, n.return), e.flags & 32) {
          var l = e.stateNode;
          try {
            On(l, "");
          } catch (T) {
            he(e, e.return, T);
          }
        }
        if (r & 4 && (l = e.stateNode, l != null)) {
          var i = e.memoizedProps, u = n !== null ? n.memoizedProps : i, o = e.type, a = e.updateQueue;
          if (e.updateQueue = null, a !== null) try {
            o === "input" && i.type === "radio" && i.name != null && Ou(l, i), Fl(o, u);
            var v = Fl(o, i);
            for (u = 0; u < a.length; u += 2) {
              var w = a[u], k = a[u + 1];
              w === "style" ? Bu(l, k) : w === "dangerouslySetInnerHTML" ? $u(l, k) : w === "children" ? On(l, k) : de(l, w, k, v);
            }
            switch (o) {
              case "input":
                Ll(l, i);
                break;
              case "textarea":
                Fu(l, i);
                break;
              case "select":
                var y = l._wrapperState.wasMultiple;
                l._wrapperState.wasMultiple = !!i.multiple;
                var N = i.value;
                N != null ? sn(l, !!i.multiple, N, !1) : y !== !!i.multiple && (i.defaultValue != null ? sn(
                  l,
                  !!i.multiple,
                  i.defaultValue,
                  !0
                ) : sn(l, !!i.multiple, i.multiple ? [] : "", !1));
            }
            l[nr] = i;
          } catch (T) {
            he(e, e.return, T);
          }
        }
        break;
      case 6:
        if (st(t, e), vt(e), r & 4) {
          if (e.stateNode === null) throw Error(s(162));
          l = e.stateNode, i = e.memoizedProps;
          try {
            l.nodeValue = i;
          } catch (T) {
            he(e, e.return, T);
          }
        }
        break;
      case 3:
        if (st(t, e), vt(e), r & 4 && n !== null && n.memoizedState.isDehydrated) try {
          Qn(t.containerInfo);
        } catch (T) {
          he(e, e.return, T);
        }
        break;
      case 4:
        st(t, e), vt(e);
        break;
      case 13:
        st(t, e), vt(e), l = e.child, l.flags & 8192 && (i = l.memoizedState !== null, l.stateNode.isHidden = i, !i || l.alternate !== null && l.alternate.memoizedState !== null || (au = ye())), r & 4 && ua(e);
        break;
      case 22:
        if (w = n !== null && n.memoizedState !== null, e.mode & 1 ? (De = (v = De) || w, st(t, e), De = v) : st(t, e), vt(e), r & 8192) {
          if (v = e.memoizedState !== null, (e.stateNode.isHidden = v) && !w && (e.mode & 1) !== 0) for (P = e, w = e.child; w !== null; ) {
            for (k = P = w; P !== null; ) {
              switch (y = P, N = y.child, y.tag) {
                case 0:
                case 11:
                case 14:
                case 15:
                  pr(4, y, y.return);
                  break;
                case 1:
                  jn(y, y.return);
                  var j = y.stateNode;
                  if (typeof j.componentWillUnmount == "function") {
                    r = y, n = y.return;
                    try {
                      t = r, j.props = t.memoizedProps, j.state = t.memoizedState, j.componentWillUnmount();
                    } catch (T) {
                      he(r, n, T);
                    }
                  }
                  break;
                case 5:
                  jn(y, y.return);
                  break;
                case 22:
                  if (y.memoizedState !== null) {
                    ca(k);
                    continue;
                  }
              }
              N !== null ? (N.return = y, P = N) : ca(k);
            }
            w = w.sibling;
          }
          e: for (w = null, k = e; ; ) {
            if (k.tag === 5) {
              if (w === null) {
                w = k;
                try {
                  l = k.stateNode, v ? (i = l.style, typeof i.setProperty == "function" ? i.setProperty("display", "none", "important") : i.display = "none") : (o = k.stateNode, a = k.memoizedProps.style, u = a != null && a.hasOwnProperty("display") ? a.display : null, o.style.display = Vu("display", u));
                } catch (T) {
                  he(e, e.return, T);
                }
              }
            } else if (k.tag === 6) {
              if (w === null) try {
                k.stateNode.nodeValue = v ? "" : k.memoizedProps;
              } catch (T) {
                he(e, e.return, T);
              }
            } else if ((k.tag !== 22 && k.tag !== 23 || k.memoizedState === null || k === e) && k.child !== null) {
              k.child.return = k, k = k.child;
              continue;
            }
            if (k === e) break e;
            for (; k.sibling === null; ) {
              if (k.return === null || k.return === e) break e;
              w === k && (w = null), k = k.return;
            }
            w === k && (w = null), k.sibling.return = k.return, k = k.sibling;
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
            if (ra(n)) {
              var r = n;
              break e;
            }
            n = n.return;
          }
          throw Error(s(160));
        }
        switch (r.tag) {
          case 5:
            var l = r.stateNode;
            r.flags & 32 && (On(l, ""), r.flags &= -33);
            var i = la(e);
            uu(e, i, l);
            break;
          case 3:
          case 4:
            var u = r.stateNode.containerInfo, o = la(e);
            iu(e, o, u);
            break;
          default:
            throw Error(s(161));
        }
      } catch (a) {
        he(e, e.return, a);
      }
      e.flags &= -3;
    }
    t & 4096 && (e.flags &= -4097);
  }
  function gf(e, t, n) {
    P = e, sa(e);
  }
  function sa(e, t, n) {
    for (var r = (e.mode & 1) !== 0; P !== null; ) {
      var l = P, i = l.child;
      if (l.tag === 22 && r) {
        var u = l.memoizedState !== null || fl;
        if (!u) {
          var o = l.alternate, a = o !== null && o.memoizedState !== null || De;
          o = fl;
          var v = De;
          if (fl = u, (De = a) && !v) for (P = l; P !== null; ) u = P, a = u.child, u.tag === 22 && u.memoizedState !== null ? fa(l) : a !== null ? (a.return = u, P = a) : fa(l);
          for (; i !== null; ) P = i, sa(i), i = i.sibling;
          P = l, fl = o, De = v;
        }
        aa(e);
      } else (l.subtreeFlags & 8772) !== 0 && i !== null ? (i.return = l, P = i) : aa(e);
    }
  }
  function aa(e) {
    for (; P !== null; ) {
      var t = P;
      if ((t.flags & 8772) !== 0) {
        var n = t.alternate;
        try {
          if ((t.flags & 8772) !== 0) switch (t.tag) {
            case 0:
            case 11:
            case 15:
              De || dl(5, t);
              break;
            case 1:
              var r = t.stateNode;
              if (t.flags & 4 && !De) if (n === null) r.componentDidMount();
              else {
                var l = t.elementType === t.type ? n.memoizedProps : ut(t.type, n.memoizedProps);
                r.componentDidUpdate(l, n.memoizedState, r.__reactInternalSnapshotBeforeUpdate);
              }
              var i = t.updateQueue;
              i !== null && cs(t, i, r);
              break;
            case 3:
              var u = t.updateQueue;
              if (u !== null) {
                if (n = null, t.child !== null) switch (t.child.tag) {
                  case 5:
                    n = t.child.stateNode;
                    break;
                  case 1:
                    n = t.child.stateNode;
                }
                cs(t, u, n);
              }
              break;
            case 5:
              var o = t.stateNode;
              if (n === null && t.flags & 4) {
                n = o;
                var a = t.memoizedProps;
                switch (t.type) {
                  case "button":
                  case "input":
                  case "select":
                  case "textarea":
                    a.autoFocus && n.focus();
                    break;
                  case "img":
                    a.src && (n.src = a.src);
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
                var v = t.alternate;
                if (v !== null) {
                  var w = v.memoizedState;
                  if (w !== null) {
                    var k = w.dehydrated;
                    k !== null && Qn(k);
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
              throw Error(s(163));
          }
          De || t.flags & 512 && lu(t);
        } catch (y) {
          he(t, t.return, y);
        }
      }
      if (t === e) {
        P = null;
        break;
      }
      if (n = t.sibling, n !== null) {
        n.return = t.return, P = n;
        break;
      }
      P = t.return;
    }
  }
  function ca(e) {
    for (; P !== null; ) {
      var t = P;
      if (t === e) {
        P = null;
        break;
      }
      var n = t.sibling;
      if (n !== null) {
        n.return = t.return, P = n;
        break;
      }
      P = t.return;
    }
  }
  function fa(e) {
    for (; P !== null; ) {
      var t = P;
      try {
        switch (t.tag) {
          case 0:
          case 11:
          case 15:
            var n = t.return;
            try {
              dl(4, t);
            } catch (a) {
              he(t, n, a);
            }
            break;
          case 1:
            var r = t.stateNode;
            if (typeof r.componentDidMount == "function") {
              var l = t.return;
              try {
                r.componentDidMount();
              } catch (a) {
                he(t, l, a);
              }
            }
            var i = t.return;
            try {
              lu(t);
            } catch (a) {
              he(t, i, a);
            }
            break;
          case 5:
            var u = t.return;
            try {
              lu(t);
            } catch (a) {
              he(t, u, a);
            }
        }
      } catch (a) {
        he(t, t.return, a);
      }
      if (t === e) {
        P = null;
        break;
      }
      var o = t.sibling;
      if (o !== null) {
        o.return = t.return, P = o;
        break;
      }
      P = t.return;
    }
  }
  var wf = Math.ceil, pl = pe.ReactCurrentDispatcher, ou = pe.ReactCurrentOwner, et = pe.ReactCurrentBatchConfig, G = 0, Ce = null, we = null, je = 0, Xe = 0, Tn = Mt(0), _e = 0, mr = null, nn = 0, ml = 0, su = 0, hr = null, $e = null, au = 0, Rn = 1 / 0, Nt = null, hl = !1, cu = null, Vt = null, vl = !1, Bt = null, yl = 0, vr = 0, fu = null, gl = -1, wl = 0;
  function Me() {
    return (G & 6) !== 0 ? ye() : gl !== -1 ? gl : gl = ye();
  }
  function Ht(e) {
    return (e.mode & 1) === 0 ? 1 : (G & 2) !== 0 && je !== 0 ? je & -je : tf.transition !== null ? (wl === 0 && (wl = ro()), wl) : (e = te, e !== 0 || (e = window.event, e = e === void 0 ? 16 : po(e.type)), e);
  }
  function at(e, t, n, r) {
    if (50 < vr) throw vr = 0, fu = null, Error(s(185));
    $n(e, n, r), ((G & 2) === 0 || e !== Ce) && (e === Ce && ((G & 2) === 0 && (ml |= n), _e === 4 && Wt(e, je)), Ve(e, r), n === 1 && G === 0 && (t.mode & 1) === 0 && (Rn = ye() + 500, Yr && Ft()));
  }
  function Ve(e, t) {
    var n = e.callbackNode;
    tc(e, t);
    var r = zr(e, e === Ce ? je : 0);
    if (r === 0) n !== null && eo(n), e.callbackNode = null, e.callbackPriority = 0;
    else if (t = r & -r, e.callbackPriority !== t) {
      if (n != null && eo(n), t === 1) e.tag === 0 ? ef(pa.bind(null, e)) : qo(pa.bind(null, e)), Zc(function() {
        (G & 6) === 0 && Ft();
      }), n = null;
      else {
        switch (lo(r)) {
          case 1:
            n = Wl;
            break;
          case 4:
            n = to;
            break;
          case 16:
            n = Er;
            break;
          case 536870912:
            n = no;
            break;
          default:
            n = Er;
        }
        n = Sa(n, da.bind(null, e));
      }
      e.callbackPriority = t, e.callbackNode = n;
    }
  }
  function da(e, t) {
    if (gl = -1, wl = 0, (G & 6) !== 0) throw Error(s(327));
    var n = e.callbackNode;
    if (Ln() && e.callbackNode !== n) return null;
    var r = zr(e, e === Ce ? je : 0);
    if (r === 0) return null;
    if ((r & 30) !== 0 || (r & e.expiredLanes) !== 0 || t) t = kl(e, r);
    else {
      t = r;
      var l = G;
      G |= 2;
      var i = ha();
      (Ce !== e || je !== t) && (Nt = null, Rn = ye() + 500, ln(e, t));
      do
        try {
          _f();
          break;
        } catch (o) {
          ma(e, o);
        }
      while (!0);
      ji(), pl.current = i, G = l, we !== null ? t = 0 : (Ce = null, je = 0, t = _e);
    }
    if (t !== 0) {
      if (t === 2 && (l = Ql(e), l !== 0 && (r = l, t = du(e, l))), t === 1) throw n = mr, ln(e, 0), Wt(e, r), Ve(e, ye()), n;
      if (t === 6) Wt(e, r);
      else {
        if (l = e.current.alternate, (r & 30) === 0 && !kf(l) && (t = kl(e, r), t === 2 && (i = Ql(e), i !== 0 && (r = i, t = du(e, i))), t === 1)) throw n = mr, ln(e, 0), Wt(e, r), Ve(e, ye()), n;
        switch (e.finishedWork = l, e.finishedLanes = r, t) {
          case 0:
          case 1:
            throw Error(s(345));
          case 2:
            un(e, $e, Nt);
            break;
          case 3:
            if (Wt(e, r), (r & 130023424) === r && (t = au + 500 - ye(), 10 < t)) {
              if (zr(e, 0) !== 0) break;
              if (l = e.suspendedLanes, (l & r) !== r) {
                Me(), e.pingedLanes |= e.suspendedLanes & l;
                break;
              }
              e.timeoutHandle = gi(un.bind(null, e, $e, Nt), t);
              break;
            }
            un(e, $e, Nt);
            break;
          case 4:
            if (Wt(e, r), (r & 4194240) === r) break;
            for (t = e.eventTimes, l = -1; 0 < r; ) {
              var u = 31 - rt(r);
              i = 1 << u, u = t[u], u > l && (l = u), r &= ~i;
            }
            if (r = l, r = ye() - r, r = (120 > r ? 120 : 480 > r ? 480 : 1080 > r ? 1080 : 1920 > r ? 1920 : 3e3 > r ? 3e3 : 4320 > r ? 4320 : 1960 * wf(r / 1960)) - r, 10 < r) {
              e.timeoutHandle = gi(un.bind(null, e, $e, Nt), r);
              break;
            }
            un(e, $e, Nt);
            break;
          case 5:
            un(e, $e, Nt);
            break;
          default:
            throw Error(s(329));
        }
      }
    }
    return Ve(e, ye()), e.callbackNode === n ? da.bind(null, e) : null;
  }
  function du(e, t) {
    var n = hr;
    return e.current.memoizedState.isDehydrated && (ln(e, t).flags |= 256), e = kl(e, t), e !== 2 && (t = $e, $e = n, t !== null && pu(t)), e;
  }
  function pu(e) {
    $e === null ? $e = e : $e.push.apply($e, e);
  }
  function kf(e) {
    for (var t = e; ; ) {
      if (t.flags & 16384) {
        var n = t.updateQueue;
        if (n !== null && (n = n.stores, n !== null)) for (var r = 0; r < n.length; r++) {
          var l = n[r], i = l.getSnapshot;
          l = l.value;
          try {
            if (!lt(i(), l)) return !1;
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
  function Wt(e, t) {
    for (t &= ~su, t &= ~ml, e.suspendedLanes |= t, e.pingedLanes &= ~t, e = e.expirationTimes; 0 < t; ) {
      var n = 31 - rt(t), r = 1 << n;
      e[n] = -1, t &= ~r;
    }
  }
  function pa(e) {
    if ((G & 6) !== 0) throw Error(s(327));
    Ln();
    var t = zr(e, 0);
    if ((t & 1) === 0) return Ve(e, ye()), null;
    var n = kl(e, t);
    if (e.tag !== 0 && n === 2) {
      var r = Ql(e);
      r !== 0 && (t = r, n = du(e, r));
    }
    if (n === 1) throw n = mr, ln(e, 0), Wt(e, t), Ve(e, ye()), n;
    if (n === 6) throw Error(s(345));
    return e.finishedWork = e.current.alternate, e.finishedLanes = t, un(e, $e, Nt), Ve(e, ye()), null;
  }
  function mu(e, t) {
    var n = G;
    G |= 1;
    try {
      return e(t);
    } finally {
      G = n, G === 0 && (Rn = ye() + 500, Yr && Ft());
    }
  }
  function rn(e) {
    Bt !== null && Bt.tag === 0 && (G & 6) === 0 && Ln();
    var t = G;
    G |= 1;
    var n = et.transition, r = te;
    try {
      if (et.transition = null, te = 1, e) return e();
    } finally {
      te = r, et.transition = n, G = t, (G & 6) === 0 && Ft();
    }
  }
  function hu() {
    Xe = Tn.current, ue(Tn);
  }
  function ln(e, t) {
    e.finishedWork = null, e.finishedLanes = 0;
    var n = e.timeoutHandle;
    if (n !== -1 && (e.timeoutHandle = -1, Gc(n)), we !== null) for (n = we.return; n !== null; ) {
      var r = n;
      switch (Ei(r), r.tag) {
        case 1:
          r = r.type.childContextTypes, r != null && Qr();
          break;
        case 3:
          Pn(), ue(Fe), ue(Te), Fi();
          break;
        case 5:
          Mi(r);
          break;
        case 4:
          Pn();
          break;
        case 13:
          ue(ce);
          break;
        case 19:
          ue(ce);
          break;
        case 10:
          Ti(r.type._context);
          break;
        case 22:
        case 23:
          hu();
      }
      n = n.return;
    }
    if (Ce = e, we = e = Qt(e.current, null), je = Xe = t, _e = 0, mr = null, su = ml = nn = 0, $e = hr = null, bt !== null) {
      for (t = 0; t < bt.length; t++) if (n = bt[t], r = n.interleaved, r !== null) {
        n.interleaved = null;
        var l = r.next, i = n.pending;
        if (i !== null) {
          var u = i.next;
          i.next = l, r.next = u;
        }
        n.pending = r;
      }
      bt = null;
    }
    return e;
  }
  function ma(e, t) {
    do {
      var n = we;
      try {
        if (ji(), rl.current = ol, ll) {
          for (var r = fe.memoizedState; r !== null; ) {
            var l = r.queue;
            l !== null && (l.pending = null), r = r.next;
          }
          ll = !1;
        }
        if (tn = 0, Ee = Se = fe = null, sr = !1, ar = 0, ou.current = null, n === null || n.return === null) {
          _e = 1, mr = t, we = null;
          break;
        }
        e: {
          var i = e, u = n.return, o = n, a = t;
          if (t = je, o.flags |= 32768, a !== null && typeof a == "object" && typeof a.then == "function") {
            var v = a, w = o, k = w.tag;
            if ((w.mode & 1) === 0 && (k === 0 || k === 11 || k === 15)) {
              var y = w.alternate;
              y ? (w.updateQueue = y.updateQueue, w.memoizedState = y.memoizedState, w.lanes = y.lanes) : (w.updateQueue = null, w.memoizedState = null);
            }
            var N = As(u);
            if (N !== null) {
              N.flags &= -257, $s(N, u, o, i, t), N.mode & 1 && Us(i, v, t), t = N, a = v;
              var j = t.updateQueue;
              if (j === null) {
                var T = /* @__PURE__ */ new Set();
                T.add(a), t.updateQueue = T;
              } else j.add(a);
              break e;
            } else {
              if ((t & 1) === 0) {
                Us(i, v, t), vu();
                break e;
              }
              a = Error(s(426));
            }
          } else if (ae && o.mode & 1) {
            var ge = As(u);
            if (ge !== null) {
              (ge.flags & 65536) === 0 && (ge.flags |= 256), $s(ge, u, o, i, t), Pi(zn(a, o));
              break e;
            }
          }
          i = a = zn(a, o), _e !== 4 && (_e = 2), hr === null ? hr = [i] : hr.push(i), i = u;
          do {
            switch (i.tag) {
              case 3:
                i.flags |= 65536, t &= -t, i.lanes |= t;
                var m = Is(i, a, t);
                as(i, m);
                break e;
              case 1:
                o = a;
                var c = i.type, h = i.stateNode;
                if ((i.flags & 128) === 0 && (typeof c.getDerivedStateFromError == "function" || h !== null && typeof h.componentDidCatch == "function" && (Vt === null || !Vt.has(h)))) {
                  i.flags |= 65536, t &= -t, i.lanes |= t;
                  var S = Fs(i, o, t);
                  as(i, S);
                  break e;
                }
            }
            i = i.return;
          } while (i !== null);
        }
        ya(n);
      } catch (R) {
        t = R, we === n && n !== null && (we = n = n.return);
        continue;
      }
      break;
    } while (!0);
  }
  function ha() {
    var e = pl.current;
    return pl.current = ol, e === null ? ol : e;
  }
  function vu() {
    (_e === 0 || _e === 3 || _e === 2) && (_e = 4), Ce === null || (nn & 268435455) === 0 && (ml & 268435455) === 0 || Wt(Ce, je);
  }
  function kl(e, t) {
    var n = G;
    G |= 2;
    var r = ha();
    (Ce !== e || je !== t) && (Nt = null, ln(e, t));
    do
      try {
        Sf();
        break;
      } catch (l) {
        ma(e, l);
      }
    while (!0);
    if (ji(), G = n, pl.current = r, we !== null) throw Error(s(261));
    return Ce = null, je = 0, _e;
  }
  function Sf() {
    for (; we !== null; ) va(we);
  }
  function _f() {
    for (; we !== null && !Ka(); ) va(we);
  }
  function va(e) {
    var t = ka(e.alternate, e, Xe);
    e.memoizedProps = e.pendingProps, t === null ? ya(e) : we = t, ou.current = null;
  }
  function ya(e) {
    var t = e;
    do {
      var n = t.alternate;
      if (e = t.return, (t.flags & 32768) === 0) {
        if (n = mf(n, t, Xe), n !== null) {
          we = n;
          return;
        }
      } else {
        if (n = hf(n, t), n !== null) {
          n.flags &= 32767, we = n;
          return;
        }
        if (e !== null) e.flags |= 32768, e.subtreeFlags = 0, e.deletions = null;
        else {
          _e = 6, we = null;
          return;
        }
      }
      if (t = t.sibling, t !== null) {
        we = t;
        return;
      }
      we = t = e;
    } while (t !== null);
    _e === 0 && (_e = 5);
  }
  function un(e, t, n) {
    var r = te, l = et.transition;
    try {
      et.transition = null, te = 1, xf(e, t, n, r);
    } finally {
      et.transition = l, te = r;
    }
    return null;
  }
  function xf(e, t, n, r) {
    do
      Ln();
    while (Bt !== null);
    if ((G & 6) !== 0) throw Error(s(327));
    n = e.finishedWork;
    var l = e.finishedLanes;
    if (n === null) return null;
    if (e.finishedWork = null, e.finishedLanes = 0, n === e.current) throw Error(s(177));
    e.callbackNode = null, e.callbackPriority = 0;
    var i = n.lanes | n.childLanes;
    if (nc(e, i), e === Ce && (we = Ce = null, je = 0), (n.subtreeFlags & 2064) === 0 && (n.flags & 2064) === 0 || vl || (vl = !0, Sa(Er, function() {
      return Ln(), null;
    })), i = (n.flags & 15990) !== 0, (n.subtreeFlags & 15990) !== 0 || i) {
      i = et.transition, et.transition = null;
      var u = te;
      te = 1;
      var o = G;
      G |= 4, ou.current = null, yf(e, n), oa(n, e), Bc(vi), Rr = !!hi, vi = hi = null, e.current = n, gf(n), Ya(), G = o, te = u, et.transition = i;
    } else e.current = n;
    if (vl && (vl = !1, Bt = e, yl = l), i = e.pendingLanes, i === 0 && (Vt = null), Za(n.stateNode), Ve(e, ye()), t !== null) for (r = e.onRecoverableError, n = 0; n < t.length; n++) l = t[n], r(l.value, { componentStack: l.stack, digest: l.digest });
    if (hl) throw hl = !1, e = cu, cu = null, e;
    return (yl & 1) !== 0 && e.tag !== 0 && Ln(), i = e.pendingLanes, (i & 1) !== 0 ? e === fu ? vr++ : (vr = 0, fu = e) : vr = 0, Ft(), null;
  }
  function Ln() {
    if (Bt !== null) {
      var e = lo(yl), t = et.transition, n = te;
      try {
        if (et.transition = null, te = 16 > e ? 16 : e, Bt === null) var r = !1;
        else {
          if (e = Bt, Bt = null, yl = 0, (G & 6) !== 0) throw Error(s(331));
          var l = G;
          for (G |= 4, P = e.current; P !== null; ) {
            var i = P, u = i.child;
            if ((P.flags & 16) !== 0) {
              var o = i.deletions;
              if (o !== null) {
                for (var a = 0; a < o.length; a++) {
                  var v = o[a];
                  for (P = v; P !== null; ) {
                    var w = P;
                    switch (w.tag) {
                      case 0:
                      case 11:
                      case 15:
                        pr(8, w, i);
                    }
                    var k = w.child;
                    if (k !== null) k.return = w, P = k;
                    else for (; P !== null; ) {
                      w = P;
                      var y = w.sibling, N = w.return;
                      if (na(w), w === v) {
                        P = null;
                        break;
                      }
                      if (y !== null) {
                        y.return = N, P = y;
                        break;
                      }
                      P = N;
                    }
                  }
                }
                var j = i.alternate;
                if (j !== null) {
                  var T = j.child;
                  if (T !== null) {
                    j.child = null;
                    do {
                      var ge = T.sibling;
                      T.sibling = null, T = ge;
                    } while (T !== null);
                  }
                }
                P = i;
              }
            }
            if ((i.subtreeFlags & 2064) !== 0 && u !== null) u.return = i, P = u;
            else e: for (; P !== null; ) {
              if (i = P, (i.flags & 2048) !== 0) switch (i.tag) {
                case 0:
                case 11:
                case 15:
                  pr(9, i, i.return);
              }
              var m = i.sibling;
              if (m !== null) {
                m.return = i.return, P = m;
                break e;
              }
              P = i.return;
            }
          }
          var c = e.current;
          for (P = c; P !== null; ) {
            u = P;
            var h = u.child;
            if ((u.subtreeFlags & 2064) !== 0 && h !== null) h.return = u, P = h;
            else e: for (u = c; P !== null; ) {
              if (o = P, (o.flags & 2048) !== 0) try {
                switch (o.tag) {
                  case 0:
                  case 11:
                  case 15:
                    dl(9, o);
                }
              } catch (R) {
                he(o, o.return, R);
              }
              if (o === u) {
                P = null;
                break e;
              }
              var S = o.sibling;
              if (S !== null) {
                S.return = o.return, P = S;
                break e;
              }
              P = o.return;
            }
          }
          if (G = l, Ft(), dt && typeof dt.onPostCommitFiberRoot == "function") try {
            dt.onPostCommitFiberRoot(Cr, e);
          } catch {
          }
          r = !0;
        }
        return r;
      } finally {
        te = n, et.transition = t;
      }
    }
    return !1;
  }
  function ga(e, t, n) {
    t = zn(n, t), t = Is(e, t, 1), e = At(e, t, 1), t = Me(), e !== null && ($n(e, 1, t), Ve(e, t));
  }
  function he(e, t, n) {
    if (e.tag === 3) ga(e, e, n);
    else for (; t !== null; ) {
      if (t.tag === 3) {
        ga(t, e, n);
        break;
      } else if (t.tag === 1) {
        var r = t.stateNode;
        if (typeof t.type.getDerivedStateFromError == "function" || typeof r.componentDidCatch == "function" && (Vt === null || !Vt.has(r))) {
          e = zn(n, e), e = Fs(t, e, 1), t = At(t, e, 1), e = Me(), t !== null && ($n(t, 1, e), Ve(t, e));
          break;
        }
      }
      t = t.return;
    }
  }
  function Ef(e, t, n) {
    var r = e.pingCache;
    r !== null && r.delete(t), t = Me(), e.pingedLanes |= e.suspendedLanes & n, Ce === e && (je & n) === n && (_e === 4 || _e === 3 && (je & 130023424) === je && 500 > ye() - au ? ln(e, 0) : su |= n), Ve(e, t);
  }
  function wa(e, t) {
    t === 0 && ((e.mode & 1) === 0 ? t = 1 : (t = Pr, Pr <<= 1, (Pr & 130023424) === 0 && (Pr = 4194304)));
    var n = Me();
    e = xt(e, t), e !== null && ($n(e, t, n), Ve(e, n));
  }
  function Cf(e) {
    var t = e.memoizedState, n = 0;
    t !== null && (n = t.retryLane), wa(e, n);
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
        throw Error(s(314));
    }
    r !== null && r.delete(t), wa(e, n);
  }
  var ka;
  ka = function(e, t, n) {
    if (e !== null) if (e.memoizedProps !== t.pendingProps || Fe.current) Ae = !0;
    else {
      if ((e.lanes & n) === 0 && (t.flags & 128) === 0) return Ae = !1, pf(e, t, n);
      Ae = (e.flags & 131072) !== 0;
    }
    else Ae = !1, ae && (t.flags & 1048576) !== 0 && bo(t, Gr, t.index);
    switch (t.lanes = 0, t.tag) {
      case 2:
        var r = t.type;
        cl(e, t), e = t.pendingProps;
        var l = kn(t, Te.current);
        Nn(t, n), l = $i(null, t, r, e, l, n);
        var i = Vi();
        return t.flags |= 1, typeof l == "object" && l !== null && typeof l.render == "function" && l.$$typeof === void 0 ? (t.tag = 1, t.memoizedState = null, t.updateQueue = null, Ue(r) ? (i = !0, Kr(t)) : i = !1, t.memoizedState = l.state !== null && l.state !== void 0 ? l.state : null, Di(t), l.updater = sl, t.stateNode = l, l._reactInternals = t, Yi(t, r, e, n), t = Ji(null, t, r, !0, i, n)) : (t.tag = 0, ae && i && xi(t), Oe(null, t, l, n), t = t.child), t;
      case 16:
        r = t.elementType;
        e: {
          switch (cl(e, t), e = t.pendingProps, l = r._init, r = l(r._payload), t.type = r, l = t.tag = zf(r), e = ut(r, e), l) {
            case 0:
              t = Zi(null, t, r, e, n);
              break e;
            case 1:
              t = Ks(null, t, r, e, n);
              break e;
            case 11:
              t = Vs(null, t, r, e, n);
              break e;
            case 14:
              t = Bs(null, t, r, ut(r.type, e), n);
              break e;
          }
          throw Error(s(
            306,
            r,
            ""
          ));
        }
        return t;
      case 0:
        return r = t.type, l = t.pendingProps, l = t.elementType === r ? l : ut(r, l), Zi(e, t, r, l, n);
      case 1:
        return r = t.type, l = t.pendingProps, l = t.elementType === r ? l : ut(r, l), Ks(e, t, r, l, n);
      case 3:
        e: {
          if (Ys(t), e === null) throw Error(s(387));
          r = t.pendingProps, i = t.memoizedState, l = i.element, ss(e, t), tl(t, r, null, n);
          var u = t.memoizedState;
          if (r = u.element, i.isDehydrated) if (i = { element: r, isDehydrated: !1, cache: u.cache, pendingSuspenseBoundaries: u.pendingSuspenseBoundaries, transitions: u.transitions }, t.updateQueue.baseState = i, t.memoizedState = i, t.flags & 256) {
            l = zn(Error(s(423)), t), t = Xs(e, t, r, n, l);
            break e;
          } else if (r !== l) {
            l = zn(Error(s(424)), t), t = Xs(e, t, r, n, l);
            break e;
          } else for (Ye = Ot(t.stateNode.containerInfo.firstChild), Ke = t, ae = !0, it = null, n = us(t, null, r, n), t.child = n; n; ) n.flags = n.flags & -3 | 4096, n = n.sibling;
          else {
            if (xn(), r === l) {
              t = Ct(e, t, n);
              break e;
            }
            Oe(e, t, r, n);
          }
          t = t.child;
        }
        return t;
      case 5:
        return fs(t), e === null && Ni(t), r = t.type, l = t.pendingProps, i = e !== null ? e.memoizedProps : null, u = l.children, yi(r, l) ? u = null : i !== null && yi(r, i) && (t.flags |= 32), Qs(e, t), Oe(e, t, u, n), t.child;
      case 6:
        return e === null && Ni(t), null;
      case 13:
        return Gs(e, t, n);
      case 4:
        return Oi(t, t.stateNode.containerInfo), r = t.pendingProps, e === null ? t.child = En(t, null, r, n) : Oe(e, t, r, n), t.child;
      case 11:
        return r = t.type, l = t.pendingProps, l = t.elementType === r ? l : ut(r, l), Vs(e, t, r, l, n);
      case 7:
        return Oe(e, t, t.pendingProps, n), t.child;
      case 8:
        return Oe(e, t, t.pendingProps.children, n), t.child;
      case 12:
        return Oe(e, t, t.pendingProps.children, n), t.child;
      case 10:
        e: {
          if (r = t.type._context, l = t.pendingProps, i = t.memoizedProps, u = l.value, le(qr, r._currentValue), r._currentValue = u, i !== null) if (lt(i.value, u)) {
            if (i.children === l.children && !Fe.current) {
              t = Ct(e, t, n);
              break e;
            }
          } else for (i = t.child, i !== null && (i.return = t); i !== null; ) {
            var o = i.dependencies;
            if (o !== null) {
              u = i.child;
              for (var a = o.firstContext; a !== null; ) {
                if (a.context === r) {
                  if (i.tag === 1) {
                    a = Et(-1, n & -n), a.tag = 2;
                    var v = i.updateQueue;
                    if (v !== null) {
                      v = v.shared;
                      var w = v.pending;
                      w === null ? a.next = a : (a.next = w.next, w.next = a), v.pending = a;
                    }
                  }
                  i.lanes |= n, a = i.alternate, a !== null && (a.lanes |= n), Ri(
                    i.return,
                    n,
                    t
                  ), o.lanes |= n;
                  break;
                }
                a = a.next;
              }
            } else if (i.tag === 10) u = i.type === t.type ? null : i.child;
            else if (i.tag === 18) {
              if (u = i.return, u === null) throw Error(s(341));
              u.lanes |= n, o = u.alternate, o !== null && (o.lanes |= n), Ri(u, n, t), u = i.sibling;
            } else u = i.child;
            if (u !== null) u.return = i;
            else for (u = i; u !== null; ) {
              if (u === t) {
                u = null;
                break;
              }
              if (i = u.sibling, i !== null) {
                i.return = u.return, u = i;
                break;
              }
              u = u.return;
            }
            i = u;
          }
          Oe(e, t, l.children, n), t = t.child;
        }
        return t;
      case 9:
        return l = t.type, r = t.pendingProps.children, Nn(t, n), l = qe(l), r = r(l), t.flags |= 1, Oe(e, t, r, n), t.child;
      case 14:
        return r = t.type, l = ut(r, t.pendingProps), l = ut(r.type, l), Bs(e, t, r, l, n);
      case 15:
        return Hs(e, t, t.type, t.pendingProps, n);
      case 17:
        return r = t.type, l = t.pendingProps, l = t.elementType === r ? l : ut(r, l), cl(e, t), t.tag = 1, Ue(r) ? (e = !0, Kr(t)) : e = !1, Nn(t, n), Os(t, r, l), Yi(t, r, l, n), Ji(null, t, r, !0, e, n);
      case 19:
        return Js(e, t, n);
      case 22:
        return Ws(e, t, n);
    }
    throw Error(s(156, t.tag));
  };
  function Sa(e, t) {
    return bu(e, t);
  }
  function Pf(e, t, n, r) {
    this.tag = e, this.key = n, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = r, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function tt(e, t, n, r) {
    return new Pf(e, t, n, r);
  }
  function yu(e) {
    return e = e.prototype, !(!e || !e.isReactComponent);
  }
  function zf(e) {
    if (typeof e == "function") return yu(e) ? 1 : 0;
    if (e != null) {
      if (e = e.$$typeof, e === ct) return 11;
      if (e === ft) return 14;
    }
    return 2;
  }
  function Qt(e, t) {
    var n = e.alternate;
    return n === null ? (n = tt(e.tag, t, e.key, e.mode), n.elementType = e.elementType, n.type = e.type, n.stateNode = e.stateNode, n.alternate = e, e.alternate = n) : (n.pendingProps = t, n.type = e.type, n.flags = 0, n.subtreeFlags = 0, n.deletions = null), n.flags = e.flags & 14680064, n.childLanes = e.childLanes, n.lanes = e.lanes, n.child = e.child, n.memoizedProps = e.memoizedProps, n.memoizedState = e.memoizedState, n.updateQueue = e.updateQueue, t = e.dependencies, n.dependencies = t === null ? null : { lanes: t.lanes, firstContext: t.firstContext }, n.sibling = e.sibling, n.index = e.index, n.ref = e.ref, n;
  }
  function Sl(e, t, n, r, l, i) {
    var u = 2;
    if (r = e, typeof e == "function") yu(e) && (u = 1);
    else if (typeof e == "string") u = 5;
    else e: switch (e) {
      case ke:
        return on(n.children, l, i, t);
      case Ge:
        u = 8, l |= 8;
        break;
      case Pt:
        return e = tt(12, n, t, l | 2), e.elementType = Pt, e.lanes = i, e;
      case He:
        return e = tt(13, n, t, l), e.elementType = He, e.lanes = i, e;
      case nt:
        return e = tt(19, n, t, l), e.elementType = nt, e.lanes = i, e;
      case me:
        return _l(n, l, i, t);
      default:
        if (typeof e == "object" && e !== null) switch (e.$$typeof) {
          case gt:
            u = 10;
            break e;
          case Yt:
            u = 9;
            break e;
          case ct:
            u = 11;
            break e;
          case ft:
            u = 14;
            break e;
          case Ie:
            u = 16, r = null;
            break e;
        }
        throw Error(s(130, e == null ? e : typeof e, ""));
    }
    return t = tt(u, n, t, l), t.elementType = e, t.type = r, t.lanes = i, t;
  }
  function on(e, t, n, r) {
    return e = tt(7, e, r, t), e.lanes = n, e;
  }
  function _l(e, t, n, r) {
    return e = tt(22, e, r, t), e.elementType = me, e.lanes = n, e.stateNode = { isHidden: !1 }, e;
  }
  function gu(e, t, n) {
    return e = tt(6, e, null, t), e.lanes = n, e;
  }
  function wu(e, t, n) {
    return t = tt(4, e.children !== null ? e.children : [], e.key, t), t.lanes = n, t.stateNode = { containerInfo: e.containerInfo, pendingChildren: null, implementation: e.implementation }, t;
  }
  function jf(e, t, n, r, l) {
    this.tag = t, this.containerInfo = e, this.finishedWork = this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.pendingContext = this.context = null, this.callbackPriority = 0, this.eventTimes = Kl(0), this.expirationTimes = Kl(-1), this.entangledLanes = this.finishedLanes = this.mutableReadLanes = this.expiredLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = Kl(0), this.identifierPrefix = r, this.onRecoverableError = l, this.mutableSourceEagerHydrationData = null;
  }
  function ku(e, t, n, r, l, i, u, o, a) {
    return e = new jf(e, t, n, o, a), t === 1 ? (t = 1, i === !0 && (t |= 8)) : t = 0, i = tt(3, null, null, t), e.current = i, i.stateNode = e, i.memoizedState = { element: r, isDehydrated: n, cache: null, transitions: null, pendingSuspenseBoundaries: null }, Di(i), e;
  }
  function Tf(e, t, n) {
    var r = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return { $$typeof: xe, key: r == null ? null : "" + r, children: e, containerInfo: t, implementation: n };
  }
  function _a(e) {
    if (!e) return It;
    e = e._reactInternals;
    e: {
      if (Xt(e) !== e || e.tag !== 1) throw Error(s(170));
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
      throw Error(s(171));
    }
    if (e.tag === 1) {
      var n = e.type;
      if (Ue(n)) return Zo(e, n, t);
    }
    return t;
  }
  function xa(e, t, n, r, l, i, u, o, a) {
    return e = ku(n, r, !0, e, l, i, u, o, a), e.context = _a(null), n = e.current, r = Me(), l = Ht(n), i = Et(r, l), i.callback = t ?? null, At(n, i, l), e.current.lanes = l, $n(e, l, r), Ve(e, r), e;
  }
  function xl(e, t, n, r) {
    var l = t.current, i = Me(), u = Ht(l);
    return n = _a(n), t.context === null ? t.context = n : t.pendingContext = n, t = Et(i, u), t.payload = { element: e }, r = r === void 0 ? null : r, r !== null && (t.callback = r), e = At(l, t, u), e !== null && (at(e, l, u, i), el(e, l, u)), u;
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
  function Ea(e, t) {
    if (e = e.memoizedState, e !== null && e.dehydrated !== null) {
      var n = e.retryLane;
      e.retryLane = n !== 0 && n < t ? n : t;
    }
  }
  function Su(e, t) {
    Ea(e, t), (e = e.alternate) && Ea(e, t);
  }
  function Rf() {
    return null;
  }
  var Ca = typeof reportError == "function" ? reportError : function(e) {
    console.error(e);
  };
  function _u(e) {
    this._internalRoot = e;
  }
  Cl.prototype.render = _u.prototype.render = function(e) {
    var t = this._internalRoot;
    if (t === null) throw Error(s(409));
    xl(e, t, null, null);
  }, Cl.prototype.unmount = _u.prototype.unmount = function() {
    var e = this._internalRoot;
    if (e !== null) {
      this._internalRoot = null;
      var t = e.containerInfo;
      rn(function() {
        xl(null, e, null, null);
      }), t[wt] = null;
    }
  };
  function Cl(e) {
    this._internalRoot = e;
  }
  Cl.prototype.unstable_scheduleHydration = function(e) {
    if (e) {
      var t = oo();
      e = { blockedOn: null, target: e, priority: t };
      for (var n = 0; n < Rt.length && t !== 0 && t < Rt[n].priority; n++) ;
      Rt.splice(n, 0, e), n === 0 && co(e);
    }
  };
  function xu(e) {
    return !(!e || e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11);
  }
  function Nl(e) {
    return !(!e || e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11 && (e.nodeType !== 8 || e.nodeValue !== " react-mount-point-unstable "));
  }
  function Na() {
  }
  function Lf(e, t, n, r, l) {
    if (l) {
      if (typeof r == "function") {
        var i = r;
        r = function() {
          var v = El(u);
          i.call(v);
        };
      }
      var u = xa(t, r, e, 0, null, !1, !1, "", Na);
      return e._reactRootContainer = u, e[wt] = u.current, er(e.nodeType === 8 ? e.parentNode : e), rn(), u;
    }
    for (; l = e.lastChild; ) e.removeChild(l);
    if (typeof r == "function") {
      var o = r;
      r = function() {
        var v = El(a);
        o.call(v);
      };
    }
    var a = ku(e, 0, !1, null, null, !1, !1, "", Na);
    return e._reactRootContainer = a, e[wt] = a.current, er(e.nodeType === 8 ? e.parentNode : e), rn(function() {
      xl(t, a, n, r);
    }), a;
  }
  function Pl(e, t, n, r, l) {
    var i = n._reactRootContainer;
    if (i) {
      var u = i;
      if (typeof l == "function") {
        var o = l;
        l = function() {
          var a = El(u);
          o.call(a);
        };
      }
      xl(t, u, e, l);
    } else u = Lf(n, t, e, l, r);
    return El(u);
  }
  io = function(e) {
    switch (e.tag) {
      case 3:
        var t = e.stateNode;
        if (t.current.memoizedState.isDehydrated) {
          var n = An(t.pendingLanes);
          n !== 0 && (Yl(t, n | 1), Ve(t, ye()), (G & 6) === 0 && (Rn = ye() + 500, Ft()));
        }
        break;
      case 13:
        rn(function() {
          var r = xt(e, 1);
          if (r !== null) {
            var l = Me();
            at(r, e, 1, l);
          }
        }), Su(e, 1);
    }
  }, Xl = function(e) {
    if (e.tag === 13) {
      var t = xt(e, 134217728);
      if (t !== null) {
        var n = Me();
        at(t, e, 134217728, n);
      }
      Su(e, 134217728);
    }
  }, uo = function(e) {
    if (e.tag === 13) {
      var t = Ht(e), n = xt(e, t);
      if (n !== null) {
        var r = Me();
        at(n, e, t, r);
      }
      Su(e, t);
    }
  }, oo = function() {
    return te;
  }, so = function(e, t) {
    var n = te;
    try {
      return te = e, t();
    } finally {
      te = n;
    }
  }, $l = function(e, t, n) {
    switch (t) {
      case "input":
        if (Ll(e, n), t = n.name, n.type === "radio" && t != null) {
          for (n = e; n.parentNode; ) n = n.parentNode;
          for (n = n.querySelectorAll("input[name=" + JSON.stringify("" + t) + '][type="radio"]'), t = 0; t < n.length; t++) {
            var r = n[t];
            if (r !== e && r.form === e.form) {
              var l = Wr(r);
              if (!l) throw Error(s(90));
              Lu(r), Ll(r, l);
            }
          }
        }
        break;
      case "textarea":
        Fu(e, n);
        break;
      case "select":
        t = n.value, t != null && sn(e, !!n.multiple, t, !1);
    }
  }, Ku = mu, Yu = rn;
  var Df = { usingClientEntryPoint: !1, Events: [rr, gn, Wr, Wu, Qu, mu] }, yr = { findFiberByHostInstance: Gt, bundleType: 0, version: "18.3.1", rendererPackageName: "react-dom" }, Of = { bundleType: yr.bundleType, version: yr.version, rendererPackageName: yr.rendererPackageName, rendererConfig: yr.rendererConfig, overrideHookState: null, overrideHookStateDeletePath: null, overrideHookStateRenamePath: null, overrideProps: null, overridePropsDeletePath: null, overridePropsRenamePath: null, setErrorHandler: null, setSuspenseHandler: null, scheduleUpdate: null, currentDispatcherRef: pe.ReactCurrentDispatcher, findHostInstanceByFiber: function(e) {
    return e = Ju(e), e === null ? null : e.stateNode;
  }, findFiberByHostInstance: yr.findFiberByHostInstance || Rf, findHostInstancesForRefresh: null, scheduleRefresh: null, scheduleRoot: null, setRefreshHandler: null, getCurrentFiber: null, reconcilerVersion: "18.3.1-next-f1338f8080-20240426" };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var zl = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!zl.isDisabled && zl.supportsFiber) try {
      Cr = zl.inject(Of), dt = zl;
    } catch {
    }
  }
  return Be.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = Df, Be.createPortal = function(e, t) {
    var n = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!xu(t)) throw Error(s(200));
    return Tf(e, t, null, n);
  }, Be.createRoot = function(e, t) {
    if (!xu(e)) throw Error(s(299));
    var n = !1, r = "", l = Ca;
    return t != null && (t.unstable_strictMode === !0 && (n = !0), t.identifierPrefix !== void 0 && (r = t.identifierPrefix), t.onRecoverableError !== void 0 && (l = t.onRecoverableError)), t = ku(e, 1, !1, null, null, n, !1, r, l), e[wt] = t.current, er(e.nodeType === 8 ? e.parentNode : e), new _u(t);
  }, Be.findDOMNode = function(e) {
    if (e == null) return null;
    if (e.nodeType === 1) return e;
    var t = e._reactInternals;
    if (t === void 0)
      throw typeof e.render == "function" ? Error(s(188)) : (e = Object.keys(e).join(","), Error(s(268, e)));
    return e = Ju(t), e = e === null ? null : e.stateNode, e;
  }, Be.flushSync = function(e) {
    return rn(e);
  }, Be.hydrate = function(e, t, n) {
    if (!Nl(t)) throw Error(s(200));
    return Pl(null, e, t, !0, n);
  }, Be.hydrateRoot = function(e, t, n) {
    if (!xu(e)) throw Error(s(405));
    var r = n != null && n.hydratedSources || null, l = !1, i = "", u = Ca;
    if (n != null && (n.unstable_strictMode === !0 && (l = !0), n.identifierPrefix !== void 0 && (i = n.identifierPrefix), n.onRecoverableError !== void 0 && (u = n.onRecoverableError)), t = xa(t, null, e, 1, n ?? null, l, !1, i, u), e[wt] = t.current, er(e), r) for (e = 0; e < r.length; e++) n = r[e], l = n._getVersion, l = l(n._source), t.mutableSourceEagerHydrationData == null ? t.mutableSourceEagerHydrationData = [n, l] : t.mutableSourceEagerHydrationData.push(
      n,
      l
    );
    return new Cl(t);
  }, Be.render = function(e, t, n) {
    if (!Nl(t)) throw Error(s(200));
    return Pl(null, e, t, !1, n);
  }, Be.unmountComponentAtNode = function(e) {
    if (!Nl(e)) throw Error(s(40));
    return e._reactRootContainer ? (rn(function() {
      Pl(null, null, e, !1, function() {
        e._reactRootContainer = null, e[wt] = null;
      });
    }), !0) : !1;
  }, Be.unstable_batchedUpdates = mu, Be.unstable_renderSubtreeIntoContainer = function(e, t, n, r) {
    if (!Nl(n)) throw Error(s(200));
    if (e == null || e._reactInternals === void 0) throw Error(s(38));
    return Pl(e, t, n, !1, r);
  }, Be.version = "18.3.1-next-f1338f8080-20240426", Be;
}
var Oa;
function Fa() {
  if (Oa) return Nu.exports;
  Oa = 1;
  function f() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(f);
      } catch (p) {
        console.error(p);
      }
  }
  return f(), Nu.exports = Wf(), Nu.exports;
}
var Ma;
function Qf() {
  if (Ma) return Tl;
  Ma = 1;
  var f = Fa();
  return Tl.createRoot = f.createRoot, Tl.hydrateRoot = f.hydrateRoot, Tl;
}
var Kf = Qf(), yt = Ru();
const Yf = {
  approve: { text: "✓ 已同意", cls: "ok" },
  allow: { text: "★ 已始终允许", cls: "ok" },
  reject: { text: "✗ 已拒绝", cls: "fail" },
  edit: { text: "✎ 已编辑", cls: "edit" }
};
class Xf {
  constructor() {
    jl(this, "subscribe", (p) => (this.listeners.add(p), () => this.listeners.delete(p)));
    jl(this, "listeners", /* @__PURE__ */ new Set());
    jl(this, "getSnapshot", () => this._snap);
    this.cards = [], this._snap = { cards: [] }, this._seq = 0, this._lastSummaryMd = null, this._pendingArms = /* @__PURE__ */ new Map(), this._gen = 0, this.onDecision = null, this.onRescue = null, this.onNewSession = null, this.onDrop = null;
  }
  _emit() {
    this._snap = { cards: this.cards.slice() };
    for (const p of this.listeners) p();
  }
  _card(p) {
    return this.cards.find((s) => s.id === p) || null;
  }
  // 按 id 整卡移除（收束路径专用）：返回真正删掉的 id 列表；emit/onDrop 由
  // 调用方统一收口（一次收束只出一份快照、一次 onDrop）
  _remove(p) {
    if (!p || !p.length) return [];
    const s = new Set(p), _ = [];
    return this.cards = this.cards.filter((x) => s.has(x.id) ? (_.push(x.id), !1) : !0), _;
  }
  // 决策入口（命令卡按钮/快捷键/模态兜底共用）：写回执徽标 + 通知 app.js 发 WS。
  // 按卡 decided 单发守卫（幽灵决策是真事故）；id 缺省时取最新 armed 未决命令卡。
  _decide(p, s, _) {
    const x = _ != null ? this._card(_) : [...this.cards].reverse().find(
      (Y) => Y.type === "command" && Y.armed && !Y.decided && !Y.done
    );
    if (!x || x.type !== "command" || x.decided || x.done) return !1;
    const I = Yf[p];
    if (!I) return !1;
    let V;
    if (p === "approve") V = { type: "approve" };
    else if (p === "allow") V = { type: "approve", allow: !0 };
    else if (p === "reject") V = { type: "reject", message: "用户拒绝了该命令" };
    else if (p === "edit")
      V = { type: "edit", edited_action: { name: "execute", args: { command: s } } }, x.command = s;
    else return !1;
    return x.decided = { text: I.text, cls: I.cls }, x.editorOpen = !1, p === "reject" && (x.rejected = !0), this._emit(), this.onDecision && this.onDecision(V, I.text, x.command, x.id), !0;
  }
  handle(p) {
    switch (p.kind) {
      case "task_start": {
        this._lastSummaryMd = null, this._pendingArms.clear(), this._gen += 1;
        break;
      }
      case "analysis_boot": {
        if (p.id == null) return;
        this.cards.push({
          id: p.id,
          type: "analysis",
          gen: this._gen,
          text: "",
          reason: "",
          loading: !0,
          done: !1
        }), this._loadingId = p.id, this._emit();
        break;
      }
      case "ai_result": {
        const s = p.text || "", _ = p.reason || "";
        if (!s && !_) return;
        const x = this._loadingId != null ? this.cards.find((I) => I.id === this._loadingId) : null;
        if (x && x.loading) {
          x.text = s, x.reason = _, x.loading = !1, x.done = !0, x.failed = !!p.failed, this._loadingId = null, this._emit();
          break;
        }
        this.cards.push({
          id: p.id != null ? p.id : ++this._seq,
          type: "analysis",
          gen: this._gen,
          text: s,
          reason: _,
          done: !0,
          failed: !!p.failed
        }), this._emit();
        break;
      }
      case "ai_collapse":
        break;
      case "alert": {
        const s = p.text || "";
        if (!s) return;
        this.cards.push({
          id: p.id != null ? p.id : ++this._seq,
          type: "alert",
          text: s,
          gen: this._gen,
          done: !0
        }), this._emit();
        break;
      }
      case "ai_card":
      case "final":
        this._applySummary(p.md ?? p.text ?? "", p.id);
        break;
      case "tool_start": {
        const s = p.command || "", x = !!s || p.name === "execute" ? {
          id: p.id != null ? p.id : ++this._seq,
          type: "command",
          gen: this._gen,
          name: p.name || "",
          command: s,
          args: p.args || "",
          // 出生判定（过近似）：allowed 只增，中途「始终允许」命中→tool_end
          // 直通 ✓（审批不至→✓ 合法迁移）；操作行存在性由它定，之后不长高
          needsApproval: !!p.needs_approval,
          reasons: Array.isArray(p.reasons) ? p.reasons.join(" · ") : p.reasons || "",
          risk: p.risk || "",
          armed: !1,
          decided: null,
          editorOpen: !1,
          rejected: !1,
          done: !1,
          failed: !1
        } : {
          id: p.id != null ? p.id : ++this._seq,
          type: "tool",
          gen: this._gen,
          name: p.name || "",
          args: p.args || "",
          done: !1,
          failed: !1
        };
        if (this.cards.push(x), this._pendingArms.has(x.id)) {
          const I = this._pendingArms.get(x.id);
          this._pendingArms.delete(x.id), this.handle(Object.assign({ kind: "command_card_waiting" }, I));
        }
        this._emit();
        break;
      }
      case "command_card_waiting": {
        const s = this._card(p.id);
        if (!s)
          return this._pendingArms.set(p.id, {
            id: p.id,
            command: p.command,
            reasons: p.reasons,
            risk: p.risk
          }), !0;
        if (s.type !== "command" || !s.needsApproval) return !1;
        if (s.done || s.decided) return !0;
        p.command && !s.command && (s.command = p.command), p.reasons && !s.reasons && (s.reasons = Array.isArray(p.reasons) ? p.reasons.join(" · ") : p.reasons), p.risk && !s.risk && (s.risk = p.risk);
        for (const _ of this.cards) _ !== s && _.armed && !_.decided && (_.armed = !1);
        return s.armed = !0, this._emit(), !0;
      }
      case "tool_end": {
        const s = this._card(p.id);
        if (!s || s.type !== "tool" && s.type !== "command" || s.done) return;
        s.done = !0, s.failed = !!p.failed, this._emit();
        break;
      }
      case "task_fail": {
        let s = [];
        if (p.reason === "interrupt")
          s = this._remove(this.cards.filter((_) => (_.type === "analysis" || _.type === "tool" || _.type === "command") && !_.done).map((_) => _.id));
        else {
          s = this._remove(this.cards.filter((_) => _.type === "command" && !_.done && !_.decided).map((_) => _.id));
          for (const _ of this.cards)
            (_.type === "tool" || _.type === "command") && !_.done && (_.done = !0, _.failed = !0);
        }
        this._emit(), s.length && this.onDrop && this.onDrop(s);
        break;
      }
      case "sweep": {
        const s = p.gen != null ? p.gen : this._gen, _ = this._remove(this.cards.filter((x) => (x.type === "tool" || x.type === "analysis" || x.type === "command") && !x.done && (x.gen || 0) <= s).map((x) => x.id));
        _.length && (this._emit(), this.onDrop && this.onDrop(_));
        break;
      }
      case "drop": {
        const s = this._remove(p.ids || []);
        s.length && (this._emit(), this.onDrop && this.onDrop(s));
        break;
      }
      case "approval_void": {
        const s = this._card(p.id);
        return s && s.armed && !s.decided && (s.armed = !1, this._emit()), !0;
      }
      case "decide":
        return this._decide(p.decision, p.edited, p.id);
      case "rescue": {
        const s = {
          id: p.id || ++this._seq,
          type: "rescue",
          gen: this._gen,
          line: p.line || "",
          ec: p.ec != null ? p.ec : "?",
          output: p.output || "",
          decided: null
        };
        this.cards.push(s), this._emit();
        break;
      }
      case "rescue_decide": {
        const s = [...this.cards].reverse().find(
          (_) => _.type === "rescue" && !_.decided
        );
        return s ? (s.decided = p.accept ? { text: "✓ 已交给 AI", cls: "ok" } : { text: "已忽略", cls: "fail" }, this._emit(), this.onRescue && this.onRescue(!!p.accept), !0) : !1;
      }
      case "approval_key": {
        const s = p.id != null ? this._card(p.id) : [...this.cards].reverse().find(
          (_) => _.type === "command" && _.armed && !_.decided && !_.done
        );
        return !s || s.type !== "command" || s.decided || s.done ? !1 : p.key === "Enter" ? this._decide("approve", null, s.id) : p.key === "e" || p.key === "E" ? (s.editorOpen = !s.editorOpen, this._emit(), !0) : p.key === "Backspace" ? this._decide("reject", null, s.id) : !1;
      }
      case "new_session": {
        const s = this._card(p.id);
        return !s || s.newSession ? !1 : (s.newSession = !0, this._emit(), this.onNewSession && this.onNewSession(s.id), !0);
      }
      case "clear":
        this.cards = [], this._pendingArms.clear(), this._emit();
        break;
    }
  }
  // 总结卡：只 push 出生即完整的卡（Phase 1 无换装）。
  // 去重：worker 会连发 ai_card(md) 与 final(md)（同一份 markdown），
  // 第二次直接跳过，避免同文双卡。
  _applySummary(p, s) {
    !p || p === this._lastSummaryMd || (this._lastSummaryMd = p, this.cards.push({
      id: s ?? ++this._seq,
      type: "summary",
      gen: this._gen,
      text: p,
      done: !0,
      failed: !1
    }), this._emit());
  }
}
var Gf = Fa(), ju = { exports: {} }, Ia;
function Zf() {
  return Ia || (Ia = 1, (function(f) {
    function p(D) {
      return String(D ?? "").replace(/[&<>"']/g, (L) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[L]);
    }
    function s(D) {
      return D.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }
    function _(D) {
      const L = [];
      let K = "";
      for (let A = 0; A < D.length; A++) {
        const $ = D[A];
        if ($ === "\\" && D[A + 1] === "|") {
          K += "|", A++;
          continue;
        }
        if ($ === "|") {
          L.push(K.trim()), K = "";
          continue;
        }
        K += $;
      }
      return L.push(K.trim()), L.length && L[0] === "" && L.shift(), L.length && L[L.length - 1] === "" && L.pop(), L;
    }
    function x(D) {
      const L = D.map(_), K = L[1].map((ne) => /^:-+:$/.test(ne) ? "center" : /-+:$/.test(ne) ? "right" : "left"), A = (ne) => K[ne] && K[ne] !== "left" ? ` class="a-${K[ne]}"` : "", $ = (ne, ve) => "<tr>" + ne.map((de, pe) => `<${ve}${A(pe)}>` + s(de) + `</${ve}>`).join("") + "</tr>";
      return '<div class="mtable"><table><thead>' + $(L[0], "th") + "</thead><tbody>" + L.slice(2).map((ne) => $(ne, "td")).join("") + "</tbody></table></div>";
    }
    const I = (D) => /^\s*\|.*\|\s*$/.test(D);
    function V(D) {
      let L = String(D ?? "");
      return (L.match(/`/g) || []).length % 2 && (L = L.slice(0, L.lastIndexOf("`"))), (L.match(/\*\*/g) || []).length % 2 && (L = L.slice(0, L.lastIndexOf("**"))), L;
    }
    const Y = new RegExp("^\\p{Extended_Pictographic}", "u"), H = /[。！？；：,.;:）)】\]」"']$/;
    function b(D) {
      const L = D.trim();
      return !L || L.includes("|") || !Y.test(L) || H.test(L) ? !1 : [...L].length <= 24;
    }
    function oe(D) {
      const L = p(String(D ?? "")).split(`
`), K = [];
      let A = null, $ = [];
      const ne = () => {
        A && (K.push("<" + A + ">" + $.join("") + "</" + A + ">"), A = null, $ = []);
      };
      for (let ve = 0; ve < L.length; ve++) {
        const de = L[ve];
        if (I(de) && ve + 1 < L.length && /^\s*\|[\s:|-]+\|\s*$/.test(L[ve + 1])) {
          ne();
          const xe = [];
          let ke = ve;
          for (; ke < L.length && I(L[ke]); ) xe.push(L[ke++]);
          K.push(x(xe)), ve = ke - 1;
          continue;
        }
        const pe = de.match(/^\s*(#{1,4})\s+(.+)$/);
        if (pe) {
          ne(), K.push('<div class="mh mh' + pe[1].length + '">' + s(pe[2]) + "</div>");
          continue;
        }
        let Pe = de.match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (Pe) {
          A !== "ol" && (ne(), A = "ol"), $.push("<li>" + s(Pe[2]) + "</li>");
          continue;
        }
        if (Pe = de.match(/^\s*[-*]\s+(.*)$/), Pe) {
          A !== "ul" && (ne(), A = "ul"), $.push("<li>" + s(Pe[1]) + "</li>");
          continue;
        }
        if (ne(), !de.trim()) {
          K.push('<div class="mgap"></div>');
          continue;
        }
        if (b(de)) {
          K.push('<div class="mh mh2">' + s(de.trim()) + "</div>");
          continue;
        }
        K.push('<div class="mline">' + s(de) + "</div>");
      }
      return ne(), K;
    }
    function X(D) {
      return oe(D).join("");
    }
    f.exports && (f.exports = {
      esc: p,
      mdInline: s,
      mdLite: X,
      mdLiteBlocks: oe,
      stripIncompleteMarkers: V,
      isBareSectionTitle: b,
      _splitRow: _,
      _renderTable: x,
      isPipeRow: I
    });
  })(ju)), ju.exports;
}
var Jf = Zf();
const qf = /* @__PURE__ */ Uf(Jf), { mdLiteBlocks: bf, stripIncompleteMarkers: ed } = qf;
function td({ card: f, dispatch: p }) {
  return f ? /* @__PURE__ */ E.jsx(nd, { card: f, dispatch: p }) : null;
}
function nd({ card: f, dispatch: p }) {
  switch (f.type) {
    case "analysis":
      return /* @__PURE__ */ E.jsx(id, { card: f, dispatch: p });
    case "summary":
      return /* @__PURE__ */ E.jsx(ud, { card: f, dispatch: p });
    case "command":
      return /* @__PURE__ */ E.jsx(od, { card: f, dispatch: p });
    case "rescue":
      return /* @__PURE__ */ E.jsx(sd, { card: f, dispatch: p });
    case "tool":
      return /* @__PURE__ */ E.jsx(ad, { card: f });
    case "alert":
      return /* @__PURE__ */ E.jsx(rd, { card: f });
    default:
      return null;
  }
}
function rd({ card: f }) {
  return /* @__PURE__ */ E.jsxs("div", { className: "acard aprobe alertcard", children: [
    /* @__PURE__ */ E.jsx("div", { className: "aphead", children: /* @__PURE__ */ E.jsx("span", { className: "apq", children: "⚠ 系统警告" }) }),
    /* @__PURE__ */ E.jsx("pre", { className: "apcode", children: f.text })
  ] });
}
function Tu({ card: f, label: p }) {
  return /* @__PURE__ */ E.jsxs("div", { className: "ahead", children: [
    /* @__PURE__ */ E.jsx("span", { className: "adot" }),
    /* @__PURE__ */ E.jsx("span", { className: "alabel", children: p })
  ] });
}
function ld(f, p) {
  const s = f || "", [_, x] = yt.useState(p ? 0 : s.length);
  return yt.useEffect(() => {
    if (!p) {
      x(s.length);
      return;
    }
    if (!s.length) {
      x(0);
      return;
    }
    x(0);
    let I = 0;
    const V = Math.max(2, Math.ceil(s.length / 55)), Y = setInterval(() => {
      I = Math.min(s.length, I + V), x(I), I >= s.length && clearInterval(Y);
    }, 22);
    return () => clearInterval(Y);
  }, [s, p]), s.slice(0, _);
}
function Ua({ src: f, strip: p, base: s = 0, typed: _ }) {
  const x = ld(f, _);
  return bf(p ? ed(x) : x).map((I, V) => /* @__PURE__ */ E.jsx(
    "div",
    {
      className: "ablk",
      style: { "--i": s + V },
      dangerouslySetInnerHTML: { __html: I }
    },
    V
  ));
}
function id({ card: f, dispatch: p }) {
  const s = f.failed ? "分析 · 已中止" : "分析";
  return f.loading ? /* @__PURE__ */ E.jsxs("div", { className: "ablock think", children: [
    /* @__PURE__ */ E.jsx(Tu, { card: f, label: s }),
    /* @__PURE__ */ E.jsx("div", { className: "atext think", children: "AI 思考中" })
  ] }) : /* @__PURE__ */ E.jsxs("div", { className: "ablock" + (f.done ? " done" : "") + (f.failed ? " failed" : ""), children: [
    /* @__PURE__ */ E.jsx(Tu, { card: f, label: s }),
    /* @__PURE__ */ E.jsxs("div", { className: "atext", children: [
      f.reason ? /* @__PURE__ */ E.jsxs("details", { className: "areason-wrap ablk", style: { "--i": 0 }, children: [
        /* @__PURE__ */ E.jsx("summary", { children: "思考过程" }),
        /* @__PURE__ */ E.jsx("div", { className: "areason", children: f.reason })
      ] }) : null,
      f.text ? /* @__PURE__ */ E.jsx(Ua, { src: f.text, strip: !0, base: f.reason ? 1 : 0, typed: !f.noType }) : null
    ] })
  ] });
}
function ud({ card: f, dispatch: p }) {
  return /* @__PURE__ */ E.jsxs("div", { className: "scard", children: [
    /* @__PURE__ */ E.jsx(Tu, { card: f, label: "总结" }),
    /* @__PURE__ */ E.jsx("div", { className: "sbody", children: /* @__PURE__ */ E.jsx(Ua, { src: f.text, typed: !f.noType }) }),
    /* @__PURE__ */ E.jsx("div", { className: "sfoot", children: f.newSession ? /* @__PURE__ */ E.jsx("span", { className: "nsstate", children: "✓ 新会话已开启" }) : /* @__PURE__ */ E.jsx(
      "button",
      {
        className: "nsbtn",
        title: "重置模型上下文，从 0 开始（不清屏）",
        onClick: () => p({ kind: "new_session", id: f.id }),
        children: "开启新会话"
      }
    ) })
  ] });
}
function od({ card: f, dispatch: p }) {
  const s = f.risk === "high", [_, x] = yt.useState(!1), I = () => x(!1), V = (A, $) => p({ kind: "decide", id: f.id, decision: A, edited: $ }), Y = () => s ? x((A) => !A) : V("approve");
  let H, b = "";
  f.rejected ? (H = "✗ 已拒绝", b = "rejected") : f.done ? (H = f.failed ? "✗ 失败" : "✓ 完成", b = f.failed ? "fail" : "ok") : f.decided ? H = "执行中…" : (H = f.needsApproval ? "等待审批" : "执行中…", f.needsApproval && (b = "waiting"));
  const oe = f.armed && !f.decided && !f.done, X = [s ? "⚠ 高危" : "", f.reasons || ""].filter(Boolean).join(" · "), D = f.decided ? f.decided.text : "", L = !!D && D !== H;
  let K = "";
  return f.editorOpen || f.decided && f.decided.cls === "edit" && !f.done && !f.rejected ? K = "editing" : f.rejected ? K = "rejected" : f.done ? K = f.failed ? "failed" : "done" : f.needsApproval && !f.decided && (K = "waiting"), /* @__PURE__ */ E.jsxs("div", { className: "acard aprobe cmdcard " + K + (s ? " high" : "") + (f.editorOpen ? " edopen" : ""), children: [
    /* @__PURE__ */ E.jsxs("div", { className: "aphead cmdhead", children: [
      /* @__PURE__ */ E.jsx("span", { className: "adot" }),
      /* @__PURE__ */ E.jsxs("span", { className: "alabel", children: [
        "调用工具：",
        f.name || "execute"
      ] }),
      /* @__PURE__ */ E.jsx("span", { className: "apstate " + b, children: H }),
      f.needsApproval ? /* @__PURE__ */ E.jsx("div", { className: "cmdacts", children: oe ? /* @__PURE__ */ E.jsxs("span", { className: "apbtns", children: [
        /* @__PURE__ */ E.jsxs("span", { className: "apexec", children: [
          /* @__PURE__ */ E.jsxs("button", { className: "primary", onClick: Y, children: [
            "执行 ",
            /* @__PURE__ */ E.jsx("kbd", { children: "Ctrl ↵" })
          ] }),
          _ && /* @__PURE__ */ E.jsxs("span", { className: "apconfirm", children: [
            /* @__PURE__ */ E.jsx("span", { className: "apconfirm-q", children: "高危命令，确认执行？" }),
            /* @__PURE__ */ E.jsx("button", { className: "primary", onClick: () => V("approve"), children: "确认执行" }),
            /* @__PURE__ */ E.jsx("button", { onClick: I, children: "取消" })
          ] })
        ] }),
        /* @__PURE__ */ E.jsxs("button", { onClick: () => {
          I(), p({ kind: "approval_key", id: f.id, key: "e" });
        }, children: [
          "修改 ",
          /* @__PURE__ */ E.jsx("kbd", { children: "Ctrl E" })
        ] }),
        /* @__PURE__ */ E.jsxs("button", { onClick: () => {
          I(), V("reject");
        }, children: [
          "拒绝 ",
          /* @__PURE__ */ E.jsx("kbd", { children: "Ctrl ⌫" })
        ] }),
        /* @__PURE__ */ E.jsx(
          "button",
          {
            className: "ghost",
            title: "本会话内同判定命令直接放行",
            onClick: () => {
              I(), V("allow");
            },
            children: "始终允许"
          }
        )
      ] }) : L ? /* @__PURE__ */ E.jsx(
        "span",
        {
          className: "apreceipt " + (f.decided ? f.decided.cls : ""),
          title: D,
          children: D
        }
      ) : null }) : null
    ] }),
    /* @__PURE__ */ E.jsxs("pre", { className: "apcode cmdcode", title: f.command || f.args, children: [
      "$ ",
      f.command || f.args
    ] }),
    /* @__PURE__ */ E.jsx("div", { className: "cmdstat", title: X, children: /* @__PURE__ */ E.jsx("span", { className: "cmdreason", children: X }) }),
    f.editorOpen && !f.decided && /* @__PURE__ */ E.jsx(cd, { card: f, dispatch: p })
  ] });
}
function sd({ card: f, dispatch: p }) {
  return /* @__PURE__ */ E.jsxs("div", { className: "acard aprobe", children: [
    /* @__PURE__ */ E.jsxs("div", { className: "aphead", children: [
      f.decided ? /* @__PURE__ */ E.jsx("span", { className: "apstate " + f.decided.cls, children: f.decided.text }) : /* @__PURE__ */ E.jsxs("span", { className: "apq", children: [
        "这行执行失败了（exit ",
        f.ec,
        "），交给 AI 处理？"
      ] }),
      !f.decided && /* @__PURE__ */ E.jsxs("span", { className: "apbtns", children: [
        /* @__PURE__ */ E.jsx(
          "button",
          {
            className: "primary",
            onClick: () => p({ kind: "rescue_decide", accept: !0 }),
            children: "交给 AI"
          }
        ),
        /* @__PURE__ */ E.jsx("button", { onClick: () => p({ kind: "rescue_decide", accept: !1 }), children: "忽略" })
      ] })
    ] }),
    /* @__PURE__ */ E.jsx("pre", { className: "apcode", children: f.line }),
    f.output ? /* @__PURE__ */ E.jsx("div", { className: "apreasons", children: f.output }) : null
  ] });
}
function ad({ card: f }) {
  return /* @__PURE__ */ E.jsxs("div", { className: "acard aprobe tcard" + (f.done ? f.failed ? " failed" : " done" : ""), children: [
    /* @__PURE__ */ E.jsxs("div", { className: "aphead", children: [
      /* @__PURE__ */ E.jsxs("span", { className: "apq", children: [
        "调用工具：",
        f.name
      ] }),
      f.done ? /* @__PURE__ */ E.jsx("span", { className: "apstate " + (f.failed ? "fail" : "ok"), children: f.failed ? "✗ 失败" : "✓ 完成" }) : null
    ] }),
    f.args ? /* @__PURE__ */ E.jsx("pre", { className: "apcode", children: f.args }) : null
  ] });
}
function cd({ card: f, dispatch: p }) {
  const [s, _] = yt.useState(f.command), x = yt.useRef(null), I = yt.useRef(null), [V, Y] = yt.useState(null);
  yt.useEffect(() => {
    Y(x.current && x.current.closest(".pane"));
  }, []), yt.useEffect(() => {
    if (!V) return;
    let b = 0;
    const oe = () => {
      const X = I.current;
      if (X) {
        if (X.focus(), document.activeElement === X) {
          X.select();
          return;
        }
        b++ < 8 && setTimeout(oe, 60);
      }
    };
    oe();
  }, [V]);
  const H = () => {
    const b = s.trim();
    b && p({ kind: "decide", id: f.id, decision: "edit", edited: b });
  };
  return /* @__PURE__ */ E.jsxs(E.Fragment, { children: [
    /* @__PURE__ */ E.jsx("span", { ref: x, hidden: !0 }),
    V ? Gf.createPortal(
      /* @__PURE__ */ E.jsxs("div", { className: "apedit", children: [
        /* @__PURE__ */ E.jsx(
          "textarea",
          {
            ref: I,
            rows: "2",
            spellCheck: "false",
            autoFocus: !0,
            value: s,
            onChange: (b) => _(b.target.value)
          }
        ),
        /* @__PURE__ */ E.jsxs("div", { className: "apedit-btns", children: [
          /* @__PURE__ */ E.jsx("button", { className: "primary", onClick: H, children: "保存并执行" }),
          /* @__PURE__ */ E.jsx("button", { onClick: () => p({ kind: "approval_key", id: f.id, key: "e" }), children: "取消" })
        ] })
      ] }),
      V
    ) : null
  ] });
}
function fd({ store: f, cardId: p }) {
  const _ = yt.useSyncExternalStore(f.subscribe, f.getSnapshot).cards.find((x) => x.id === p) || null;
  return /* @__PURE__ */ E.jsx(td, { card: _, dispatch: (x) => f.handle(x) });
}
function pd(f) {
  const p = new Xf();
  f && f.onDecision && (p.onDecision = f.onDecision), f && f.onRescue && (p.onRescue = f.onRescue), f && f.onNewSession && (p.onNewSession = f.onNewSession), f && f.onDrop && (p.onDrop = f.onDrop);
  const s = /* @__PURE__ */ new Map();
  return {
    handle: (_) => p.handle(_),
    mount(_, x) {
      const I = s.get(_);
      if (I) {
        if (I.el === x) return;
        console.warn(
          "[island] root 迁移重挂",
          _,
          "prevConnected=",
          I.el && I.el.isConnected,
          "sameParent=",
          I.el && x && I.el.parentNode === x.parentNode
        ), s.delete(_);
        try {
          I.root.unmount();
        } catch {
        }
      }
      const V = Kf.createRoot(x);
      V.render(/* @__PURE__ */ E.jsx(fd, { store: p, cardId: _ })), s.set(_, { root: V, el: x });
    },
    unmount(_) {
      const x = s.get(_);
      if (x) {
        s.delete(_);
        try {
          x.root.unmount();
        } catch {
        }
      }
    },
    destroy() {
      for (const _ of [...s.keys()]) this.unmount(_);
    }
  };
}
export {
  pd as createFeed
};
