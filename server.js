/* ============================================================
   STAR COLLECTOR — online multiplayer server (1–6 players)
   Node.js + ws. Server-authoritative simulation at 60Hz,
   snapshots broadcast at 30Hz. Static client served from /public.
   Run:  npm install && npm start   →  http://localhost:3000
   ============================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

/* ============================================================
   CONFIG — every tunable in one place (sane range in comments)
   ============================================================ */
const CONFIG = {
  port: process.env.PORT || 3000,

  // --- Round / framework ---
  roundLength: 45,            // s; plays well from 15–60
  arenaW: 1280, arenaH: 720,
  minPlayers: 1, maxPlayers: 6,
  splashSeconds: 3,           // instruction splash before GO
  finalRushAt: 10,            // timer turns red, spawns ramp

  // --- Ship movement ---
  shipThrust: 270,            // px/s² (200–340)
  shipTurnRate: 3.8,          // rad/s
  shipDrag: 0.55,             // /s
  shipMaxSpeed: 430,          // px/s
  shipRadius: 15,             // px collision radius

  // --- Stardust economy ---
  dustSpawnEvery: 0.55,       // s (0.35–0.9)
  dustMaxOnScreen: 22,
  clusterChance: 0.08,        // 5x cluster odds
  clusterValue: 5,
  magnetRadius: 58,           // pickup generosity (40–80)
  magnetPull: 340,
  finalRushSpawnMult: 1.5,    // comeback window

  // --- Rich-get-richer loop ---
  accelPerDust: 0.02,         // +2%/unit
  accelCap: 0.80,             // max +80%

  // --- Debris (now shootable!) ---
  debrisCount: 7,             // rocks maintained on field (5–9)
  debrisSpeed: [28, 85],
  debrisRadius: [16, 32],
  debrisRespawn: 3.5,         // s to replace destroyed/lost rocks
  debrisSplitR: 20,           // rocks bigger than this split when shot
  debrisDropChance: 0.35,     // odds a destroyed rock drops 1 stardust
  panicDebris: 3,             // extra fast rocks in final stretch
  panicDebrisSpeed: [130, 190],
  panicAt: 15,                // s remaining
  debrisStun: 0.5,
  debrisDropPct: 0.20,        // dust scattered on crash
  debrisKnockback: 260,

  // --- Blaster ---
  fireCooldown: 1.2,          // s between shots (1.0–2.0)
  projSpeed: 470,
  projLife: 1.3,
  hitSlowFactor: 0.40,        // target speed while slowed
  hitSlowTime: 2.0,
  hitDustLoss: 3,             // dust knocked loose per direct hit
  invulnTime: 1.5,            // post-hit immunity (anti stun-lock)

  // --- Power-up stars (rarer than stardust) ---
  powerSpawnEvery: [7, 11],   // s between power spawns (5–14)
  powerMaxOnField: 2,
  powerDur: 8,                // s for weapon powers (tri/shotgun/laser)
  invincDur: 6,               // s of invincibility
  shrinkFactor: 0.6,          // ship radius multiplier, rest of round
  triSpread: 0.26,            // rad between tri-shot projectiles
  shotgunPellets: 6,
  shotgunSpread: 0.55,        // rad total cone
  shotgunLife: 0.5,           // pellets fizzle fast (short range)
  shotgunSpeed: [380, 540],
  laserRange: 720,            // hitscan beam length; pierces everything

  // --- Net ---
  tickHz: 60,                 // simulation rate
  snapEvery: 2,               // broadcast every N ticks (2 = 30Hz)
};

/* Power-up catalog — colors match the brief exactly */
const POWERS = {
  tri:     { color: "#3dff6e", name: "TRI-SHOT" },      // green
  shotgun: { color: "#a855f7", name: "SHOTGUN" },        // purple
  invinc:  { color: "#ff9a3d", name: "INVINCIBLE" },     // orange
  laser:   { color: "#ffffff", name: "LASER" },          // white
  shrink:  { color: "#ff2ec4", name: "SHRINK" },         // fuchsia
};
const POWER_TYPES = Object.keys(POWERS);

/* 6-player roster (client mirrors colors/shapes by slot) */
const SLOT_COLORS = ["#ffd23f","#41e0d0","#ff6b9d","#a97bff","#4e9bff","#ff5d5d"];

/* ---------- utils ---------- */
const TAU = Math.PI * 2;
const rand = (a,b) => a + Math.random() * (b - a);
const randi = (a,b) => Math.floor(rand(a, b + 1));
const clamp = (v,a,b) => v < a ? a : v > b ? b : v;
const dist2 = (ax,ay,bx,by) => { const dx=ax-bx, dy=ay-by; return dx*dx+dy*dy; };
function wrapDelta(a,b,span){ let d=b-a; if(d>span/2)d-=span; if(d<-span/2)d+=span; return d; }
function wrapPos(e){ const W=CONFIG.arenaW,H=CONFIG.arenaH;
  if(e.x<0)e.x+=W; else if(e.x>=W)e.x-=W;
  if(e.y<0)e.y+=H; else if(e.y>=H)e.y-=H; }
let NEXT_ID = 1;
const nid = () => NEXT_ID++;

/* ============================================================
   GAME SIMULATION (server-authoritative)
   ============================================================ */
class StarCollector {
  constructor(playersBySlot){ // [{slot,name}]
    const C = CONFIG;
    this.time = C.roundLength;
    this.over = false;
    this.dustTimer = 0;
    this.powerTimer = rand(...C.powerSpawnEvery) * 0.6; // first power arrives early-ish
    this.debrisRespawnT = 0;
    this.panicSpawned = false;
    this.motes = []; this.debris = []; this.shots = []; this.powers = [];
    this.beams = [];       // laser visuals, short-lived
    this.events = [];      // sfx/popup events drained into each snapshot

    this.ships = playersBySlot.map((p,i) => {
      const n = playersBySlot.length;
      const a = (i / n) * TAU - Math.PI / 2;
      return {
        slot: p.slot, name: p.name,
        x: C.arenaW/2 + Math.cos(a)*190, y: C.arenaH/2 + Math.sin(a)*150,
        vx: 0, vy: 0, ang: a,
        dust: 0, total: 0,
        cool: 0, stun: 0, slow: 0, invuln: 0, flash: 0,
        thrusting: false,
        input: { l:false, r:false, u:false }, fireQ: false,
        power: null, powerT: 0, shrunk: false,
      };
    });
    for(let i=0;i<C.debrisCount;i++) this.debris.push(this.makeDebris(false, true));
    for(let i=0;i<8;i++) this.spawnMote();
  }

  ev(type, data){ this.events.push(Object.assign({ e:type }, data)); }

  radiusOf(s){ return CONFIG.shipRadius * (s.shrunk ? CONFIG.shrinkFactor : 1); }
  invincible(s){ return s.power === "invinc"; }

  makeDebris(panic, anywhere=false){
    const C = CONFIG;
    const sp = panic ? C.panicDebrisSpeed : C.debrisSpeed;
    const a = rand(0, TAU), s = rand(sp[0], sp[1]);
    const r = panic ? rand(12,18) : rand(C.debrisRadius[0], C.debrisRadius[1]);
    let x, y;
    if(anywhere && Math.random()<0.5){ x = rand(0,C.arenaW); y = rand(0,C.arenaH);
      // keep initial rocks off the ship ring
      if(dist2(x,y,C.arenaW/2,C.arenaH/2) < 260*260){ x = 30; y = 30; }
    } else {
      const edge = randi(0,3);
      if(edge===0){x=rand(0,C.arenaW);y=-r;} else if(edge===1){x=rand(0,C.arenaW);y=C.arenaH+r;}
      else if(edge===2){x=-r;y=rand(0,C.arenaH);} else {x=C.arenaW+r;y=rand(0,C.arenaH);}
    }
    const verts=[]; const vn=randi(7,10);
    for(let i=0;i<vn;i++) verts.push(rand(0.72,1.0));
    return { id:nid(), x, y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, r, rot:rand(0,TAU),
             spin:rand(-1.2,1.2), verts, panic };
  }

  spawnMote(x, y, value){
    const C = CONFIG;
    const cluster = value === undefined && Math.random() < C.clusterChance;
    const v = value ?? (cluster ? C.clusterValue : 1);
    this.motes.push({ id:nid(), x: x ?? rand(30,C.arenaW-30), y: y ?? rand(60,C.arenaH-40),
      value: v, r: v > 1 ? 10 : 5 });
  }

  spawnPower(){
    const C = CONFIG;
    const type = POWER_TYPES[randi(0, POWER_TYPES.length-1)];
    this.powers.push({ id:nid(), type,
      x: rand(60, C.arenaW-60), y: rand(80, C.arenaH-60), r: 12 });
  }

  scatterDust(x, y, amount){
    for(let i=0;i<amount;i++){
      const a = rand(0,TAU), d = rand(20,70);
      this.spawnMote(clamp(x+Math.cos(a)*d,10,CONFIG.arenaW-10),
                     clamp(y+Math.sin(a)*d,10,CONFIG.arenaH-10), 1);
    }
  }

  removeShip(slot){ this.ships = this.ships.filter(s => s.slot !== slot); }

  /* --- shot/laser hits a rock: split big ones, pop small ones --- */
  damageDebris(d, hitterColor){
    d.dead = true;
    this.ev("boom", { x:d.x, y:d.y, c:hitterColor, r:d.r });
    if(d.r > CONFIG.debrisSplitR){
      for(let i=0;i<2;i++){
        const child = this.makeDebris(d.panic);
        child.x = d.x + rand(-8,8); child.y = d.y + rand(-8,8);
        child.r = d.r * rand(0.5, 0.62);
        const a = rand(0,TAU), s = Math.hypot(d.vx,d.vy) * rand(1.1,1.5) + 30;
        child.vx = Math.cos(a)*s; child.vy = Math.sin(a)*s;
        this.debris.push(child);
      }
    } else if(Math.random() < CONFIG.debrisDropChance){
      this.spawnMote(d.x, d.y, 1);   // shooting rocks can pay off
    }
  }

  /* --- apply a weapon hit to a ship (shot pellet or laser) --- */
  hitShip(target, attacker){
    const C = CONFIG;
    target.slow = C.hitSlowTime;
    target.invuln = C.invulnTime;
    target.flash = 0.35;
    const loss = Math.min(C.hitDustLoss, target.dust);
    if(loss > 0){ target.dust -= loss; this.scatterDust(target.x, target.y, loss); }
    this.ev("zap", { x:target.x, y:target.y, c:SLOT_COLORS[attacker.slot],
      txt: loss>0 ? ("-"+loss) : "ZAPPED!", who: target.name });
  }

  fireWeapon(s){
    const C = CONFIG;
    const col = SLOT_COLORS[s.slot];
    const mk = (ang, speed, life) => this.shots.push({
      id:nid(), x: s.x + Math.cos(ang)*18, y: s.y + Math.sin(ang)*18,
      vx: Math.cos(ang)*speed + s.vx, vy: Math.sin(ang)*speed + s.vy,
      life, owner: s.slot });

    if(s.power === "tri"){
      for(const off of [-C.triSpread, 0, C.triSpread]) mk(s.ang+off, C.projSpeed, C.projLife);
      this.ev("fire", {});
    } else if(s.power === "shotgun"){
      for(let i=0;i<C.shotgunPellets;i++)
        mk(s.ang + rand(-C.shotgunSpread/2, C.shotgunSpread/2),
           rand(...C.shotgunSpeed), C.shotgunLife * rand(0.8,1.1));
      this.ev("fire", { big:true });
    } else if(s.power === "laser"){
      // hitscan: pierce every ship and rock along the beam
      const dx = Math.cos(s.ang), dy = Math.sin(s.ang);
      this.beams.push({ x:s.x, y:s.y, ang:s.ang, owner:s.slot, t:0.16 });
      for(const o of this.ships){
        if(o.slot === s.slot || o.invuln > 0 || this.invincible(o)) continue;
        if(this.pointBeamDist(o.x, o.y, s, dx, dy) < this.radiusOf(o) + 5) this.hitShip(o, s);
      }
      for(const d of this.debris){
        if(!d.dead && this.pointBeamDist(d.x, d.y, s, dx, dy) < d.r) this.damageDebris(d, col);
      }
      this.debris = this.debris.filter(d => !d.dead);
      this.ev("laser", {});
    } else {
      mk(s.ang, C.projSpeed, C.projLife);
      this.ev("fire", {});
    }
  }

  pointBeamDist(px, py, s, dx, dy){
    // distance from point to the beam segment starting at ship, length laserRange
    const rx = wrapDelta(s.x, px, CONFIG.arenaW), ry = wrapDelta(s.y, py, CONFIG.arenaH);
    const t = clamp(rx*dx + ry*dy, 0, CONFIG.laserRange);
    return Math.hypot(rx - dx*t, ry - dy*t);
  }

  update(dt){
    const C = CONFIG;
    this.time -= dt;
    if(this.time <= 0){ this.time = 0; this.over = true; return; }
    const finalRush = this.time <= C.finalRushAt;

    if(!this.panicSpawned && this.time <= C.panicAt){
      this.panicSpawned = true;
      for(let i=0;i<C.panicDebris;i++) this.debris.push(this.makeDebris(true));
      this.ev("storm", {});
    }

    // stardust
    this.dustTimer -= dt * (finalRush ? C.finalRushSpawnMult : 1);
    if(this.dustTimer <= 0 && this.motes.length < C.dustMaxOnScreen){
      this.spawnMote(); this.dustTimer = C.dustSpawnEvery;
    }

    // power-ups (rarer)
    this.powerTimer -= dt;
    if(this.powerTimer <= 0 && this.powers.length < C.powerMaxOnField){
      this.spawnPower(); this.powerTimer = rand(...C.powerSpawnEvery);
    }

    // keep the rock field populated
    if(this.debris.filter(d=>!d.panic).length < C.debrisCount){
      this.debrisRespawnT -= dt;
      if(this.debrisRespawnT <= 0){ this.debris.push(this.makeDebris(false)); this.debrisRespawnT = C.debrisRespawn; }
    }

    for(const d of this.debris){ d.x+=d.vx*dt; d.y+=d.vy*dt; d.rot+=d.spin*dt; wrapPos(d); }
    for(const b of this.beams) b.t -= dt;
    this.beams = this.beams.filter(b => b.t > 0);

    // ships
    for(const s of this.ships){
      s.cool=Math.max(0,s.cool-dt); s.stun=Math.max(0,s.stun-dt);
      s.slow=Math.max(0,s.slow-dt); s.invuln=Math.max(0,s.invuln-dt);
      s.flash=Math.max(0,s.flash-dt);
      s.thrusting=false;
      if(s.power && s.powerT !== Infinity){
        s.powerT -= dt;
        if(s.powerT <= 0){ s.power = null; }
      }

      if(s.stun<=0){
        if(s.input.l) s.ang -= C.shipTurnRate*dt;
        if(s.input.r) s.ang += C.shipTurnRate*dt;
        if(s.input.u){
          const bonus = 1 + Math.min(s.dust*C.accelPerDust, C.accelCap);
          const slowMul = s.slow>0 ? C.hitSlowFactor : 1;
          s.vx += Math.cos(s.ang)*C.shipThrust*bonus*slowMul*dt;
          s.vy += Math.sin(s.ang)*C.shipThrust*bonus*slowMul*dt;
          s.thrusting = true;
        }
        if(s.fireQ && s.cool<=0){ s.cool = C.fireCooldown; this.fireWeapon(s); }
      }
      s.fireQ = false;

      const drag=Math.exp(-C.shipDrag*dt); s.vx*=drag; s.vy*=drag;
      const cap=C.shipMaxSpeed*(s.slow>0?C.hitSlowFactor:1);
      const sp=Math.hypot(s.vx,s.vy);
      if(sp>cap){ s.vx*=cap/sp; s.vy*=cap/sp; }
      s.x+=s.vx*dt; s.y+=s.vy*dt; wrapPos(s);

      // debris crash (invincible ships plow right through)
      if(s.invuln<=0 && !this.invincible(s)){
        for(const d of this.debris){
          if(dist2(s.x,s.y,d.x,d.y) < (this.radiusOf(s)+d.r*0.85)**2){
            const nx=wrapDelta(d.x,s.x,C.arenaW), ny=wrapDelta(d.y,s.y,C.arenaH);
            const nl=Math.hypot(nx,ny)||1;
            s.vx=nx/nl*C.debrisKnockback; s.vy=ny/nl*C.debrisKnockback;
            s.stun=C.debrisStun; s.invuln=C.invulnTime; s.flash=0.3;
            const dropped=Math.floor(s.dust*C.debrisDropPct);
            if(dropped>0){ s.dust-=dropped; this.scatterDust(s.x,s.y,dropped); }
            this.ev("crash",{x:s.x,y:s.y,drop:dropped});
            break;
          }
        }
      }

      // stardust magnet + pickup
      for(const m of this.motes){
        const dx=wrapDelta(m.x,s.x,C.arenaW), dy=wrapDelta(m.y,s.y,C.arenaH);
        const d2=dx*dx+dy*dy;
        if(d2 < C.magnetRadius**2){
          const dl=Math.sqrt(d2)||1;
          m.x+=dx/dl*C.magnetPull*dt; m.y+=dy/dl*C.magnetPull*dt; wrapPos(m);
        }
        if(d2 < (this.radiusOf(s)+m.r)**2){
          s.dust+=m.value; s.total+=m.value; m.dead=true;
          this.ev("pickup",{x:m.x,y:m.y,c:SLOT_COLORS[s.slot],v:m.value});
        }
      }

      // power-up pickup (no magnet — you have to earn these)
      for(const p of this.powers){
        if(dist2(s.x,s.y,p.x,p.y) < (this.radiusOf(s)+p.r)**2){
          p.dead=true;
          if(p.type === "shrink"){ s.shrunk = true; }
          else { s.power = p.type; s.powerT = p.type==="invinc" ? C.invincDur : C.powerDur; }
          this.ev("power",{x:s.x,y:s.y,type:p.type,who:s.name,c:POWERS[p.type].color});
        }
      }
    }
    this.motes = this.motes.filter(m=>!m.dead);
    this.powers = this.powers.filter(p=>!p.dead);

    // projectiles: hit ships AND rocks
    for(const b of this.shots){
      b.life-=dt; b.x+=b.vx*dt; b.y+=b.vy*dt; wrapPos(b);
      if(b.life<=0){ b.dead=true; continue; }
      for(const s of this.ships){
        if(s.slot===b.owner || s.invuln>0 || this.invincible(s)) continue;
        if(dist2(b.x,b.y,s.x,s.y) < (this.radiusOf(s)+4)**2){
          b.dead=true;
          const attacker = this.ships.find(o=>o.slot===b.owner) || {slot:b.owner};
          this.hitShip(s, attacker);
          break;
        }
      }
      if(b.dead) continue;
      for(const d of this.debris){
        if(!d.dead && dist2(b.x,b.y,d.x,d.y) < (d.r+4)**2){
          b.dead=true; this.damageDebris(d, SLOT_COLORS[b.owner]); break;
        }
      }
    }
    this.shots = this.shots.filter(b=>!b.dead);
    this.debris = this.debris.filter(d=>!d.dead);
  }

  results(){
    const rows = this.ships.slice().sort((a,b)=> b.dust-a.dust || b.total-a.total);
    if(rows.length === 0) return { label:"ROUND OVER", rows:[] };
    if(rows.length === 1)
      return { label: rows[0].name+" scored ★"+rows[0].dust+"!", winners:[rows[0].slot],
               rows: rows.map(r=>({slot:r.slot,name:r.name,dust:r.dust,total:r.total})) };
    const best = rows[0].dust;
    let lead = rows.filter(s=>s.dust===best);
    let label, winners;
    if(lead.length>1){
      const bt = Math.max(...lead.map(s=>s.total));
      const lead2 = lead.filter(s=>s.total===bt);
      if(lead2.length===1){ label = lead2[0].name+" WINS THE TIEBREAK!"; winners=[lead2[0].slot]; }
      else { label = "SHARED VICTORY!"; winners = lead.map(s=>s.slot); }
    } else { label = lead[0].name+" WINS!"; winners=[lead[0].slot]; }
    return { label, winners, rows: rows.map(r=>({slot:r.slot,name:r.name,dust:r.dust,total:r.total})) };
  }

  snapshot(phase, extra){
    const snap = {
      t:"snap", ph:phase, time:+this.time.toFixed(2),
      ships: this.ships.map(s=>({ sl:s.slot, x:+s.x.toFixed(1), y:+s.y.toFixed(1),
        a:+s.ang.toFixed(3), d:s.dust, st:+s.stun.toFixed(2), sw:+s.slow.toFixed(2),
        iv:+s.invuln.toFixed(2), fl:s.flash>0?1:0, th:s.thrusting?1:0,
        pw:s.power||"", pt:s.power && s.powerT!==Infinity ? +s.powerT.toFixed(1) : 0,
        sh:s.shrunk?1:0, nm:s.name })),
      motes: this.motes.map(m=>[m.id, +m.x.toFixed(1), +m.y.toFixed(1), m.value]),
      deb: this.debris.map(d=>[d.id, +d.x.toFixed(1), +d.y.toFixed(1), +d.r.toFixed(1),
        +d.rot.toFixed(2), d.panic?1:0, d.verts.map(v=>+v.toFixed(2))]),
      shots: this.shots.map(b=>[b.id, +b.x.toFixed(1), +b.y.toFixed(1), b.owner]),
      pows: this.powers.map(p=>[p.id, +p.x.toFixed(1), +p.y.toFixed(1), p.type]),
      beams: this.beams.map(b=>[+b.x.toFixed(1), +b.y.toFixed(1), +b.ang.toFixed(3), b.owner]),
      ev: this.events.splice(0),
    };
    if(extra) Object.assign(snap, extra);
    return snap;
  }
}

/* ============================================================
   ROOMS + PROTOCOL
   client→server: join {name,room} · input {l,r,u} · fire ·
                  start · again · lobby
   server→client: joined · room (lobby roster) · snap · error
   ============================================================ */
const rooms = new Map(); // code → Room

function makeCode(){
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c; do { c = Array.from({length:4},()=>A[randi(0,A.length-1)]).join(""); } while(rooms.has(c));
  return c;
}

class Room {
  constructor(code){
    this.code = code;
    this.clients = new Map();  // id → {ws, name, slot, alive}
    this.state = "LOBBY";      // LOBBY | SPLASH | PLAY | RESULTS
    this.game = null;
    this.splashT = 0; this.tick = 0; this.resultsSnap = null;
    this.timer = setInterval(()=>this.update(1/CONFIG.tickHz), 1000/CONFIG.tickHz);
  }
  freeSlot(){
    const used = new Set([...this.clients.values()].map(c=>c.slot));
    for(let i=0;i<CONFIG.maxPlayers;i++) if(!used.has(i)) return i;
    return -1;
  }
  hostId(){
    let best=null, bestSlot=99;
    for(const [id,c] of this.clients) if(c.slot<bestSlot){ bestSlot=c.slot; best=id; }
    return best;
  }
  broadcast(obj){
    const msg = JSON.stringify(obj);
    for(const c of this.clients.values())
      if(c.ws.readyState === 1) c.ws.send(msg);
  }
  roster(){
    return [...this.clients.entries()]
      .sort((a,b)=>a[1].slot-b[1].slot)
      .map(([id,c])=>({slot:c.slot,name:c.name,host:id===this.hostId(),
        inRound: this.game ? this.game.ships.some(s=>s.slot===c.slot) : false}));
  }
  sendRoom(){
    this.broadcast({ t:"room", code:this.code, state:this.state, players:this.roster(),
      min:CONFIG.minPlayers, max:CONFIG.maxPlayers });
  }
  startRound(){
    const players = this.roster().map(p=>({slot:p.slot,name:p.name}));
    if(players.length < CONFIG.minPlayers) return;
    this.game = new StarCollector(players);
    this.state = "SPLASH"; this.splashT = CONFIG.splashSeconds + 1;
    this.sendRoom();
  }
  update(dt){
    this.tick++;
    if(this.state === "SPLASH"){
      this.splashT -= dt;
      if(this.splashT <= 0) this.state = "PLAY";
      if(this.tick % CONFIG.snapEvery === 0)
        this.broadcast(this.game.snapshot("SPLASH", { cd: Math.max(0, Math.ceil(this.splashT)-1) }));
    }
    else if(this.state === "PLAY"){
      this.game.update(dt);
      if(this.game.over){
        this.state = "RESULTS";
        this.resultsSnap = this.game.snapshot("RESULTS", { res: this.game.results() });
        this.broadcast(this.resultsSnap);
      } else if(this.tick % CONFIG.snapEvery === 0){
        this.broadcast(this.game.snapshot("PLAY"));
      }
    }
  }
  destroyIfEmpty(){
    if(this.clients.size === 0){ clearInterval(this.timer); rooms.delete(this.code); }
  }
}

/* ============================================================
   HTTP static server + WebSocket upgrade
   ============================================================ */
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css",
  ".png":"image/png", ".ico":"image/x-icon", ".svg":"image/svg+xml" };
const PUB = path.join(__dirname, "public");

const server = http.createServer((req,res)=>{
  let url = req.url.split("?")[0];
  if(url === "/") url = "/index.html";
  const file = path.join(PUB, path.normalize(url).replace(/^(\.\.[\/\\])+/, ""));
  if(!file.startsWith(PUB)){ res.writeHead(403); return res.end(); }
  fs.readFile(file, (err,data)=>{
    if(err){ res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {"Content-Type": MIME[path.extname(file)] || "application/octet-stream"});
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws)=>{
  let room = null, id = crypto.randomUUID();

  ws.on("message", (raw)=>{
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if(msg.t === "join" && !room){
      let code = (msg.room||"").toUpperCase().replace(/[^A-Z]/g,"").slice(0,4);
      if(!code || !rooms.has(code)){
        if(code && !rooms.has(code) && msg.strict){
          return ws.send(JSON.stringify({t:"error", m:"Room "+code+" not found."}));
        }
        code = code && !rooms.has(code) ? code : makeCode();
        rooms.set(code, new Room(code));
      }
      room = rooms.get(code);
      const slot = room.freeSlot();
      if(slot === -1){ return ws.send(JSON.stringify({t:"error", m:"Room is full (6 pilots max)."})); }
      const name = String(msg.name||"").trim().slice(0,10) || ("P"+(slot+1));
      room.clients.set(id, { ws, name, slot });
      ws.send(JSON.stringify({ t:"joined", id, slot, code, config:{
        arenaW:CONFIG.arenaW, arenaH:CONFIG.arenaH, roundLength:CONFIG.roundLength,
        finalRushAt:CONFIG.finalRushAt, magnetRadius:CONFIG.magnetRadius }}));
      room.sendRoom();
      // late joiner during a round spectates until next round
      if(room.state === "RESULTS" && room.resultsSnap) ws.send(JSON.stringify(room.resultsSnap));
      return;
    }
    if(!room) return;
    const me = room.clients.get(id);
    if(!me) return;

    switch(msg.t){
      case "input": {
        if(room.game){
          const s = room.game.ships.find(x=>x.slot===me.slot);
          if(s) s.input = { l:!!msg.l, r:!!msg.r, u:!!msg.u };
        }
        break;
      }
      case "fire": {
        if(room.game && room.state === "PLAY"){
          const s = room.game.ships.find(x=>x.slot===me.slot);
          if(s) s.fireQ = true;
        }
        break;
      }
      case "start":
        if(id === room.hostId() && room.state === "LOBBY") room.startRound();
        break;
      case "again":
        if(id === room.hostId() && room.state === "RESULTS") room.startRound();
        break;
      case "lobby":
        if(id === room.hostId() && room.state === "RESULTS"){
          room.state = "LOBBY"; room.game = null; room.sendRoom();
        }
        break;
    }
  });

  ws.on("close", ()=>{
    if(!room) return;
    const me = room.clients.get(id);
    room.clients.delete(id);
    if(me && room.game) room.game.removeShip(me.slot);
    room.sendRoom();
    room.destroyIfEmpty();
  });
});

if(require.main === module){
  server.listen(CONFIG.port, ()=>{
    console.log("★ Star Collector server on http://localhost:" + CONFIG.port);
    console.log("  Share your room link and battle from any machine on the network.");
  });
}
module.exports = { StarCollector, CONFIG, POWERS };
