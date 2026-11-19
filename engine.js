/* Ride engine for the north-coast out-and-back. No DOM. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RideEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var PLAN_KMH = 17;
  var M_PER_DEG_LAT = 110540;

  function mPerDegLng(lat) {
    return 111320 * Math.cos((lat * Math.PI) / 180);
  }

  function distM(a, b) {
    var lat0 = (a.lat + b.lat) / 2;
    var x = (b.lng - a.lng) * mPerDegLng(lat0);
    var y = (b.lat - a.lat) * M_PER_DEG_LAT;
    return Math.hypot(x, y);
  }

  /** Taipei is UTC+8 year-round. h/mi are wall-clock in Taipei. */
  function taipeiMs(y, mo, d, h, mi) {
    return Date.UTC(y, mo - 1, d, h - 8, mi || 0, 0, 0);
  }

  var DEFAULT_START = taipeiMs(2026, 11, 22, 8, 0);

  /* Pinned clock, minutes after 08:00. Pass-through checkpoints are not
     pinned; each leg uses one moving pace and the rests sit on top. */
  var CAOLI_ARRIVE_MIN = 210;
  var CAOLI_DEPART_MIN = 300;
  var FINISH_MIN = 470;
  var PLAN_REST = { tamsui: 10, baisha: 10, caoli: 90 };
  var COFFEE_MIN = 30;

  function createRide(routeLL, defs, options) {
    options = options || {};
    var outbound = [];
    var m = 0;
    outbound.push({ lat: routeLL[0][0], lng: routeLL[0][1], m: 0 });
    for (var i = 1; i < routeLL.length; i++) {
      var p = { lat: routeLL[i][0], lng: routeLL[i][1] };
      var step = distM(outbound[outbound.length - 1], p);
      if (step < 0.4) continue;
      m += step;
      outbound.push({ lat: p.lat, lng: p.lng, m: m });
    }
    var turnM = m;
    var pts = outbound.slice();
    for (var j = outbound.length - 2; j >= 0; j--) {
      var q = outbound[j];
      m += distM(pts[pts.length - 1], q);
      pts.push({ lat: q.lat, lng: q.lng, m: m });
    }
    var totalM = m;

    function lowerBound(target) {
      var lo = 0;
      var hi = pts.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (pts[mid].m < target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    function project(lat, lng, a, b) {
      var lat0 = (a.lat + b.lat) / 2;
      var kx = mPerDegLng(lat0);
      var bx = (b.lng - a.lng) * kx;
      var by = (b.lat - a.lat) * M_PER_DEG_LAT;
      var px = (lng - a.lng) * kx;
      var py = (lat - a.lat) * M_PER_DEG_LAT;
      var L2 = bx * bx + by * by;
      var t = 0;
      var cross;
      if (L2 < 0.25) {
        cross = Math.hypot(px, py);
        t = 0;
      } else {
        t = (px * bx + py * by) / L2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        cross = Math.hypot(px - t * bx, py - t * by);
      }
      return { m: a.m + t * (b.m - a.m), cross: cross, t: t };
    }

    function projectOnto(lat, lng, fromM, toM) {
      var i0 = Math.max(0, lowerBound(fromM) - 1);
      var i1 = Math.min(pts.length - 1, lowerBound(toM) + 1);
      var best = null;
      for (var i = i0; i < i1; i++) {
        var proj = project(lat, lng, pts[i], pts[i + 1]);
        if (!best || proj.cross < best.cross) best = { m: proj.m, cross: proj.cross, idx: i };
      }
      return best;
    }

    /* Prefer forward progress when two legs of the out-and-back are both close. */
    function searchScored(lat, lng, last, fromM, toM) {
      var i0 = Math.max(0, lowerBound(fromM) - 1);
      var i1 = Math.min(pts.length - 1, lowerBound(toM) + 1);
      var best = null;
      for (var i = i0; i < i1; i++) {
        var proj = project(lat, lng, pts[i], pts[i + 1]);
        var forward = proj.m - last;
        var score = proj.cross;
        /* Backward matches are the other copy of an out-and-back, or a
           short street loop. Penalize them so a point sitting on the line
           ahead of us wins over the same coordinates a few dozen meters back. */
        if (forward < -12) score += (-forward) * 0.4;
        else if (forward < 0) score += (-forward) * 0.05;
        else score += forward * 0.01;
        if (!best || score < best.score) {
          best = { m: proj.m, cross: proj.cross, idx: i, score: score };
        }
      }
      return best;
    }

    /**
     * Snap a GPS fix to the route.
     * Outbound and return share the same roads, so the search stays in a
     * window around the previous distance instead of jumping to whichever
     * copy of the road is nearest. Near the turnaround, forward progress
     * wins so the rider crosses onto the return instead of sticking outbound.
     */
    function snap(lat, lng, prev) {
      prev = prev || { m: 0, turned: false };
      var last = prev.m || 0;
      var turned = !!prev.turned;
      var from = Math.max(0, last - 260);
      var to = last + 650;
      if (!turned && last < turnM - 300) to = Math.min(to, turnM + 30);
      var best = searchScored(lat, lng, last, from, to);
      if (best && best.cross > 48) {
        var to2 = last + 1600;
        if (!turned) to2 = Math.min(to2, turnM + 40);
        var alt = searchScored(lat, lng, last, Math.max(0, last - 40), to2);
        if (alt && alt.cross < 26 && alt.m >= last - 40) best = alt;
      }
      if (!best) {
        return { m: last, cross: 9999, off: true, turned: turned };
      }
      var off = best.cross > 75;
      var nextM = last;
      var nowTurned = turned;
      if (!off) {
        if (best.m < last - 180) {
          /* single-fix backward spike */
        } else {
          nextM = best.m;
          if (nextM >= turnM - 20) nowTurned = true;
        }
      }
      return { m: nextM, cross: best.cross, off: off, turned: nowTurned };
    }

    function align(lat, lng) {
      var out = projectOnto(lat, lng, 0, turnM);
      var back = projectOnto(lat, lng, turnM, totalM);
      return { out: out, back: back };
    }

    function pointAt(dist) {
      if (dist <= 0) return { lat: pts[0].lat, lng: pts[0].lng, m: 0 };
      if (dist >= totalM) {
        var last = pts[pts.length - 1];
        return { lat: last.lat, lng: last.lng, m: totalM };
      }
      var i = lowerBound(dist);
      if (i <= 0) return { lat: pts[0].lat, lng: pts[0].lng, m: 0 };
      if (i >= pts.length) i = pts.length - 1;
      var b = pts[i];
      var a = pts[i - 1];
      var span = b.m - a.m || 1;
      var f = (dist - a.m) / span;
      return {
        lat: a.lat + f * (b.lat - a.lat),
        lng: a.lng + f * (b.lng - a.lng),
        m: dist
      };
    }

    function nearestOnOutbound(lat, lng) {
      var best = projectOnto(lat, lng, 0, turnM);
      return best ? best.m : 0;
    }

    var checkpoints = [];
    defs.forEach(function (d) {
      var cm = 0;
      if (d.at === "start") cm = 0;
      else if (d.at === "turn") cm = turnM;
      else cm = nearestOnOutbound(d.lat, d.lng);
      checkpoints.push({
        id: d.id,
        name: d.name,
        m: cm,
        restMin: PLAN_REST[d.id] || 0,
        note: d.note || "",
        bailout: false,
        leg: "out"
      });
    });
    checkpoints.sort(function (a, b) { return a.m - b.m; });
    /* return copies, far side first as we walk back */
    var back = [];
    checkpoints.forEach(function (c) {
      if (c.m < 80 || c.m > turnM - 80) return;
      var id = c.id + "-back";
      var name = c.name + "（回）";
      var note = "";
      var bailout = false;
      if (c.id === "tamsui") name = "淡水市區（回）";
      if (c.id === "hongshulin") {
        bailout = true;
        note = "可收車搭捷運淡水線";
      }
      if (c.id === "qianshui") note = "咖啡可選";
      back.push({
        id: id,
        name: name,
        m: totalM - c.m,
        restMin: 0,
        note: note,
        bailout: bailout,
        leg: "back",
        pair: c.id
      });
    });
    back.sort(function (a, b) { return a.m - b.m; });
    checkpoints = checkpoints.concat(back);
    checkpoints.push({
      id: "finish",
      name: "大稻埕碼頭",
      m: totalM,
      restMin: 0,
      note: "終點",
      bailout: false,
      leg: "back"
    });
    checkpoints.sort(function (a, b) { return a.m - b.m; });

    var startMs = options.startMs || DEFAULT_START;
    var includeRests = options.includeRests !== false;
    var coffeeStop = !!options.coffeeStop;
    var segments = [];
    var timed = [];
    var finishMs = startMs;

    function coffeeBackM() {
      for (var i = 0; i < checkpoints.length; i++) {
        if (checkpoints[i].id === "qianshui-back") return checkpoints[i].m;
      }
      return totalM;
    }

    function restOf(cp) {
      var r = includeRests ? (cp.restMin || 0) : 0;
      if (coffeeStop && cp.id === "qianshui-back") r += COFFEE_MIN;
      return r;
    }

    /* One pace out to 草里, one pace back. Rests are pauses, not pace changes. */
    function offsets() {
      var shortRest = includeRests ? (PLAN_REST.tamsui + PLAN_REST.baisha) : 0;
      var outMove = CAOLI_ARRIVE_MIN - shortRest;
      var lunch = includeRests ? PLAN_REST.caoli : 0;
      var retMove = FINISH_MIN - CAOLI_DEPART_MIN;
      var out = {};
      var ret = {};
      var restSoFar = 0;
      for (var i = 0; i < checkpoints.length; i++) {
        var cp = checkpoints[i];
        if (cp.m <= turnM + 0.5) {
          var move = (cp.m / turnM) * outMove;
          out[cp.id] = move + restSoFar;
          if (cp.m < turnM - 1) restSoFar += includeRests ? (cp.restMin || 0) : 0;
        } else {
          var moveBack = ((cp.m - turnM) / (totalM - turnM)) * retMove;
          var extra = (coffeeStop && cp.m > coffeeBackM() + 1) ? COFFEE_MIN : 0;
          ret[cp.id] = (CAOLI_ARRIVE_MIN + lunch) + moveBack + extra;
        }
      }
      return { out: out, ret: ret };
    }

    function rebuild() {
      var off = offsets();
      segments = [];
      timed = [];
      var prevM = 0;
      var prevDepart = startMs;
      checkpoints.forEach(function (cp) {
        var arrMin = cp.m <= turnM + 0.5 ? off.out[cp.id] : off.ret[cp.id];
        var tArr = startMs + arrMin * 60000;
        if (tArr < prevDepart) tArr = prevDepart;
        var dmKm = (cp.m - prevM) / 1000;
        if (dmKm > 0.0005 && tArr > prevDepart + 500) {
          segments.push({ type: "ride", t0: prevDepart, t1: tArr, m0: prevM, m1: cp.m });
        }
        var rest = restOf(cp);
        var tDep = tArr + rest * 60000;
        if (rest > 0.01) {
          segments.push({ type: "rest", t0: tArr, t1: tDep, m: cp.m });
        }
        var pace = 0;
        if (dmKm > 0.05 && tArr > prevDepart) {
          pace = dmKm / ((tArr - prevDepart) / 3600000);
        }
        timed.push({
          id: cp.id,
          name: cp.name,
          m: cp.m,
          restMin: rest,
          note: cp.note,
          bailout: cp.bailout,
          leg: cp.leg,
          arrive: tArr,
          depart: tDep,
          paceKmh: pace
        });
        prevM = cp.m;
        prevDepart = tDep;
      });
      finishMs = prevDepart;
    }
    rebuild();

    function plannedM(now) {
      if (now <= startMs) return 0;
      if (now >= finishMs) return totalM;
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        if (now < s.t0 || now >= s.t1) continue;
        if (s.type === "rest") return s.m;
        var f = (now - s.t0) / (s.t1 - s.t0 || 1);
        return s.m0 + f * (s.m1 - s.m0);
      }
      return totalM;
    }

    function earliestMs(dist) {
      if (dist <= 0) return startMs;
      if (dist >= totalM - 0.5) {
        return timed.length ? timed[timed.length - 1].arrive : finishMs;
      }
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        if (s.type === "ride" && dist >= s.m0 - 0.01 && dist <= s.m1 + 0.01) {
          var f = (dist - s.m0) / (s.m1 - s.m0 || 1);
          return s.t0 + f * (s.t1 - s.t0);
        }
        if (s.type === "rest" && Math.abs(dist - s.m) < 1) return s.t0;
      }
      return finishMs;
    }

    function latestMs(dist) {
      var ans = startMs;
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        if (s.type === "ride" && dist >= s.m0 - 0.01 && dist <= s.m1 + 0.01) {
          var f = (dist - s.m0) / (s.m1 - s.m0 || 1);
          ans = s.t0 + f * (s.t1 - s.t0);
        }
        if (s.type === "rest" && Math.abs(dist - s.m) < 20) ans = s.t1;
      }
      return ans;
    }

    /**
     * Positive minutes means ahead of schedule.
     * On a planned rest, sitting at that checkpoint is exactly on time.
     */
    function ahead(actualM, now) {
      var planned = plannedM(now);
      var dm = actualM - planned;
      if (Math.abs(dm) < 40) return { min: 0, meters: dm, planned: planned };
      var tRef = dm > 0 ? earliestMs(actualM) : latestMs(actualM);
      return { min: (tRef - now) / 60000, meters: dm, planned: planned };
    }

    function remainingRestMin(actualM, now) {
      var n = 0;
      for (var i = 0; i < timed.length; i++) {
        var c = timed[i];
        if (!(c.restMin > 0)) continue;
        if (c.m < actualM - 80) continue;
        if (now != null && now >= c.depart) continue;
        if (now != null && now > c.arrive) n += Math.max(0, (c.depart - now) / 60000);
        else n += c.restMin;
      }
      return n;
    }

    function averagePlanKmh() {
      var moveMs = 0;
      for (var i = 0; i < segments.length; i++) {
        if (segments[i].type === "ride") moveMs += segments[i].t1 - segments[i].t0;
      }
      if (moveMs < 1000) return PLAN_KMH;
      return (totalM / 1000) / (moveMs / 3600000);
    }

    function projectFinish(actualM, now, paceKmh) {
      var pace = paceKmh && paceKmh >= 3 ? paceKmh : averagePlanKmh();
      var remainKm = Math.max(0, (totalM - actualM) / 1000);
      var restMin = remainingRestMin(actualM, now);
      var finish = now + (remainKm / pace) * 3600000 + restMin * 60000;
      return { finish: finish, pace: pace, restMin: restMin, remainKm: remainKm };
    }

    function dayClock(h, mi) {
      var tz = 8 * 3600000;
      var local = new Date(startMs + tz);
      return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h - 8, mi, 0, 0);
    }

    function safetyMs() { return dayClock(16, 30); }
    function sunsetMs() { return dayClock(17, 4); }

    return {
      points: pts,
      outboundCount: outbound.length,
      turnM: turnM,
      totalM: totalM,
      get planKmh() { return averagePlanKmh(); },
      snap: snap,
      align: align,
      pointAt: pointAt,
      plannedM: plannedM,
      earliestMs: earliestMs,
      latestMs: latestMs,
      ahead: ahead,
      projectFinish: projectFinish,
      safetyMs: safetyMs,
      sunsetMs: sunsetMs,
      remainingRestMin: remainingRestMin,
      get startMs() { return startMs; },
      set startMs(v) { startMs = v; rebuild(); },
      get includeRests() { return includeRests; },
      set includeRests(v) { includeRests = !!v; rebuild(); },
      get coffeeStop() { return coffeeStop; },
      set coffeeStop(v) { coffeeStop = !!v; rebuild(); },
      get finishMs() { return finishMs; },
      timed: function () { return timed; },
      segments: function () { return segments; },
      mirror: function (dist) {
        if (dist < 400) return null;
        if (dist >= turnM - 20) return dist;
        return totalM - dist;
      }
    };
  }

  function selfTest(ride) {
    var failed = 0;
    var logs = [];
    function assert(cond, msg) {
      logs.push((cond ? "PASS " : "FAIL ") + msg);
      if (!cond) failed++;
    }
    var totalKm = ride.totalM / 1000;
    var turnKm = ride.turnM / 1000;
    assert(totalKm > 99.5 && totalKm < 103.5, "round trip " + totalKm.toFixed(2) + " km is about 101");
    assert(turnKm > 49.5 && turnKm < 51.8, "turnaround " + turnKm.toFixed(2) + " km is about 50.5");

    var timed = ride.timed();
    function mins(ms) { return (ms - ride.startMs) / 60000; }
    function byId(id) {
      for (var i = 0; i < timed.length; i++) if (timed[i].id === id) return timed[i];
      return null;
    }
    logs.push("TIMETABLE");
    timed.forEach(function (c) {
      logs.push(
        "  " + (c.m / 1000).toFixed(2) + " km  " + c.name +
        "  +" + mins(c.arrive).toFixed(0) + " min  rest " + c.restMin +
        "  pace " + (c.paceKmh ? c.paceKmh.toFixed(1) : "-")
      );
    });

    var guandu = byId("guandu");
    var tamsui = byId("tamsui");
    var qian = byId("qianshui");
    var baisha = byId("baisha");
    var turn = byId("caoli");
    var qianBack = byId("qianshui-back");
    var tamsuiBack = byId("tamsui-back");
    var hongBack = byId("hongshulin-back");
    var outMove = 190;
    var retMove = 170;
    function outExpect(m, restsBefore) {
      return (m / ride.turnM) * outMove + restsBefore;
    }
    assert(tamsui.restMin === 10, "捷運淡水站 rest is 10 min");
    assert(baisha.restMin === 10, "白沙灣 rest is 10 min");
    assert(qian.restMin === 0, "outbound 淺水灣 has no stop");
    assert(Math.abs(mins(guandu.arrive) - outExpect(guandu.m, 0)) < 0.3, "關渡 time comes from the outbound pace");
    assert(Math.abs(mins(qian.arrive) - outExpect(qian.m, 10)) < 0.3, "outbound 淺水灣 time comes from the outbound pace");
    assert(Math.abs(mins(baisha.arrive) - outExpect(baisha.m, 10)) < 0.3, "白沙灣 arrival comes from the outbound pace");
    assert(Math.abs(guandu.paceKmh - qian.paceKmh) < 0.15 && Math.abs(qian.paceKmh - baisha.paceKmh) < 0.15,
      "outbound pass-throughs share one pace (" + guandu.paceKmh.toFixed(1) + " km/h)");
    assert(baisha.paceKmh < 22, "淺水灣→白沙灣 is not a 33 km/h spike (" + baisha.paceKmh.toFixed(1) + ")");
    assert(Math.abs(mins(turn.arrive) - 210) < 0.2 && turn.restMin === 90, "草里 arrives 11:30 and lunch is 90 min");
    assert(Math.abs(mins(turn.depart) - 300) < 0.2, "草里 departs 13:00");
    var backExpect = 300 + ((qianBack.m - ride.turnM) / (ride.totalM - ride.turnM)) * retMove;
    var tamsuiBackExpect = 300 + ((tamsuiBack.m - ride.turnM) / (ride.totalM - ride.turnM)) * retMove;
    assert(Math.abs(mins(qianBack.arrive) - backExpect) < 0.3, "return 淺水灣 comes from the return pace");
    assert(Math.abs(mins(tamsuiBack.arrive) - tamsuiBackExpect) < 0.3, "return 淡水 comes from the return pace");
    assert(Math.abs(qianBack.paceKmh - tamsuiBack.paceKmh) < 0.2, "return pass-throughs share one pace");
    assert(qianBack.restMin === 0, "return coffee is off by default");
    assert(Math.abs(mins(ride.finishMs) - 470) < 0.3, "finish is 15:50");
    assert(hongBack && hongBack.bailout && !tamsui.bailout && !tamsuiBack.bailout, "bailout is 紅樹林站, not 淡水站");

    /* on schedule the whole way, including through rests */
    var bad = 0;
    var worst = 0;
    for (var t = ride.startMs; t <= ride.finishMs; t += 30000) {
      var pm = ride.plannedM(t);
      var a = ride.ahead(pm, t);
      if (Math.abs(a.min) > 0.6 || Math.abs(a.meters) > 45) {
        bad++;
        if (Math.abs(a.min) > worst) worst = Math.abs(a.min);
      }
    }
    assert(bad === 0, "on-pace rider stays within 0.6 min the whole ride (bad samples " + bad + ", worst " + worst.toFixed(2) + ")");

    var early = ride.ahead(tamsui.m, tamsui.arrive - 10 * 60000);
    assert(early.min > 9 && early.min < 11.2, "10 min early to 淡水站 reads ahead " + early.min.toFixed(2));
    var late = ride.ahead(tamsui.m, tamsui.depart + 10 * 60000);
    assert(late.min < -9 && late.min > -12, "10 min after the 淡水 rest reads behind " + late.min.toFixed(2));
    var midT = tamsui.depart + 15 * 60000;
    var midP = ride.plannedM(midT);
    var fast = ride.ahead(midP + 2000, midT);
    var segPace = 0;
    ride.segments().forEach(function (s) {
      if (s.type === "ride" && midT >= s.t0 && midT < s.t1) {
        segPace = ((s.m1 - s.m0) / 1000) / ((s.t1 - s.t0) / 3600000);
      }
    });
    var expectMin = (2 / segPace) * 60;
    assert(segPace > 5 && Math.abs(fast.min - expectMin) < 0.6, "2 km ahead matches this segment's pace (" + expectMin.toFixed(2) + " vs " + fast.min.toFixed(2) + ")");
    var slow = ride.ahead(Math.max(0, midP - 2000), midT);
    assert(slow.min < -3, "2 km behind is negative minutes (" + slow.min.toFixed(2) + ")");

    var sit = ride.ahead(turn.m, turn.arrive + 40 * 60000);
    assert(Math.abs(sit.min) < 0.2, "lunch at 草里 on schedule is ~0 (" + sit.min.toFixed(2) + ")");

    /* snap follows the polyline out and back */
    var prev = { m: 0, turned: false };
    var maxErr = 0;
    var offN = 0;
    var backN = 0;
    var turnedAt = -1;
    for (var i = 0; i < ride.points.length; i++) {
      var p = ride.points[i];
      var s = ride.snap(p.lat, p.lng, prev);
      var err = Math.abs(s.m - p.m);
      if (err > maxErr) maxErr = err;
      if (s.off) offN++;
      if (s.m + 8 < prev.m) backN++;
      if (s.turned && turnedAt < 0) turnedAt = p.m;
      prev = s;
    }
    assert(maxErr < 35, "snap error along full route max " + maxErr.toFixed(1) + " m");
    assert(offN === 0, "snap never marks the route itself off-route (" + offN + ")");
    assert(backN === 0, "snap does not jump backward (" + backN + ")");
    assert(turnedAt >= ride.turnM - 40, "turned flag flips at the turnaround");

    /* same coordinate must not leap to the return leg while still outbound */
    var at8 = ride.pointAt(8000);
    var nearStart = ride.snap(at8.lat, at8.lng, { m: 200, turned: false });
    assert(nearStart.off && nearStart.m < 1000, "a far point does not yank progress (" + nearStart.m.toFixed(0) + " off " + nearStart.off + ")");
    var follow = ride.snap(at8.lat, at8.lng, { m: 7600, turned: false });
    assert(!follow.off && Math.abs(follow.m - 8000) < 40, "windowed snap hits 8 km (" + follow.m.toFixed(0) + ")");
    var mirrorM = ride.totalM - 8000;
    var backFix = ride.snap(at8.lat, at8.lng, { m: mirrorM - 300, turned: true });
    assert(!backFix.off && Math.abs(backFix.m - mirrorM) < 50, "after turnaround the same point snaps to the return (" + backFix.m.toFixed(0) + " vs " + mirrorM.toFixed(0) + ")");

    var both = ride.align(at8.lat, at8.lng);
    assert(Math.abs(both.out.m - 8000) < 30, "align outbound ~8 km");
    assert(Math.abs(both.back.m - mirrorM) < 30, "align return is the mirror");
    assert(both.out.cross < 8 && both.back.cross < 8, "align cross-track is tiny");

    var mirrored = ride.mirror(12000);
    assert(Math.abs(mirrored - (ride.totalM - 12000)) < 1, "manual turnaround mirrors distance");

    /* rests off drops 10 + 10 + 90 minutes; coffee adds 30 and lands in 16:15–16:30 */
    var withRest = ride.finishMs;
    ride.includeRests = false;
    assert(Math.abs((withRest - ride.finishMs) - 90 * 60000) < 3000, "skipping lunch shortens the plan by 90 min; 草里 stays 11:30");
    ride.includeRests = true;
    ride.coffeeStop = true;
    var coffeeFinish = ride.finishMs;
    var coffeeQ = null;
    ride.timed().forEach(function (c) { if (c.id === "qianshui-back") coffeeQ = c; });
    assert(coffeeQ && coffeeQ.restMin === 30, "coffee toggle adds 30 min at return 淺水灣");
    assert(Math.abs((coffeeFinish - withRest) - 30 * 60000) < 3000, "coffee pushes the finish back by 30 min");
    assert((coffeeFinish - ride.startMs) / 60000 >= 495 && (coffeeFinish - ride.startMs) / 60000 <= 510,
      "with coffee the finish is 16:15–16:30");
    ride.coffeeStop = false;

    var shifted = ride.startMs;
    ride.startMs = shifted + 30 * 60000;
    assert(ride.finishMs - withRest === 30 * 60000 || Math.abs(ride.finishMs - (withRest + 30 * 60000)) < 5,
      "shifting the start shifts the finish by the same amount");
    ride.startMs = shifted;

    /* safety line and a too-slow projection */
    var safe = ride.safetyMs();
    var startParts = new Date(ride.startMs + 8 * 3600000);
    assert(startParts.getUTCHours() === 8 && startParts.getUTCMinutes() === 0, "default start is 08:00 Taipei");
    var safeParts = new Date(safe + 8 * 3600000);
    assert(safeParts.getUTCHours() === 16 && safeParts.getUTCMinutes() === 30, "safety line is 16:30 Taipei");
    var sun = new Date(ride.sunsetMs() + 8 * 3600000);
    assert(sun.getUTCHours() === 17 && sun.getUTCMinutes() === 4, "sunset is 17:04 Taipei");
    var onPace = ride.projectFinish(0, ride.startMs, ride.planKmh);
    assert(onPace.finish <= safe, "planned pace finishes by 16:30");
    assert(Math.abs(onPace.finish - ride.finishMs) < 5000, "projection at plan pace matches the timetable");
    var slowDay = ride.projectFinish(0, ride.startMs, 10);
    assert(slowDay.finish > safe, "10 km/h from the start warns past 16:30");

    /* demo-style integration: fake GPS walks the route at plan pace, including rests */
    var simM = 0;
    var simT = ride.startMs;
    var simPrev = { m: 0, turned: false };
    var simBad = 0;
    var simWorst = 0;
    var guard = 0;
    while (simM < ride.totalM - 30 && guard < 20000) {
      guard++;
      var here = ride.plannedM(simT);
      /* advance 20 seconds of plan, but move the rider with the plan */
      simT += 20000;
      if (simT > ride.finishMs) simT = ride.finishMs;
      var next = ride.plannedM(simT);
      var cursor = simM;
      while (cursor < next - 1) {
        var hop = Math.min(25, next - cursor);
        cursor += hop;
        var pos = ride.pointAt(cursor);
        simPrev = ride.snap(pos.lat, pos.lng, simPrev);
      }
      simM = next;
      var verdict = ride.ahead(simPrev.m, simT);
      var errMin = Math.abs(verdict.min);
      if (errMin > simWorst) simWorst = errMin;
      if (errMin > 1.2 || Math.abs(simPrev.m - simM) > 80) simBad++;
      if (simT >= ride.finishMs) break;
    }
    assert(simM > ride.totalM - 50, "demo walk reaches the finish (" + (simM / 1000).toFixed(2) + " km)");
    assert(simBad === 0, "demo walk stays on schedule (bad " + simBad + ", worst " + simWorst.toFixed(2) + " min, snapped " + (simPrev.m / 1000).toFixed(2) + " km)");
    assert(simPrev.turned, "demo walk is on the return leg at the end");

    return { ok: failed === 0, failed: failed, logs: logs, totalKm: totalKm, turnKm: turnKm };
  }

  return {
    createRide: createRide,
    selfTest: selfTest,
    PLAN_KMH: PLAN_KMH,
    taipeiMs: taipeiMs,
    DEFAULT_START: DEFAULT_START
  };
});
