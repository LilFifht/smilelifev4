#!/usr/bin/env node
/**
 * SmileLife — Serveur multijoueur local
 * Node.js pur, aucune dépendance
 */

const http   = require('http');
const crypto = require('crypto');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');

const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════
//  WebSocket (RFC 6455) — buffer robuste
// ══════════════════════════════════════════════════════════
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsHandshake(req, socket) {
  const key    = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsMakeFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = payload.length;
  let hdr;
  if (len < 126) {
    hdr = Buffer.alloc(2); hdr[0] = 0x81; hdr[1] = len;
  } else if (len < 65536) {
    hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 126; hdr.writeUInt16BE(len, 2);
  } else {
    hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([hdr, payload]);
}

function wsSend(socket, obj) {
  if (!socket || socket.destroyed) return;
  try { socket.write(wsMakeFrame(obj)); } catch (_) {}
}

// Retourne { messages, remaining }
// On conserve le reste si un frame est incomplet — c'est le fix principal !
function wsParse(buf) {
  const messages = [];
  let offset = 0;

  while (true) {
    if (buf.length - offset < 2) break;

    const b0 = buf[offset], b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let hdrLen = 2;

    if (payloadLen === 126) {
      if (buf.length - offset < 4) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      hdrLen = 4;
    } else if (payloadLen === 127) {
      if (buf.length - offset < 10) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      hdrLen = 10;
    }
    if (masked) hdrLen += 4;

    const total = hdrLen + payloadLen;
    if (buf.length - offset < total) break; // frame incomplète → on attend

    if (opcode === 0x8) { messages.push(null); offset += total; break; } // close
    if (opcode === 0x9) { offset += total; continue; }                   // ping ignoré

    const maskKey = masked ? buf.slice(offset + hdrLen - 4, offset + hdrLen) : null;
    const raw = Buffer.from(buf.slice(offset + hdrLen, offset + total));
    if (masked && maskKey) for (let i = 0; i < raw.length; i++) raw[i] ^= maskKey[i % 4];

    try { messages.push(JSON.parse(raw.toString('utf8'))); } catch (_) {}
    offset += total;
  }

  return { messages, remaining: buf.slice(offset) };
}

// ══════════════════════════════════════════════════════════
//  Cartes
// ══════════════════════════════════════════════════════════
const CARDS_BASE = [
  { id:'study1', name:'BAC',           cat:'study',   smiles:1, emoji:'📝', desc:'Première étape',       req:null,     type:'life',   ext:'base' },
  { id:'study2', name:'Licence',       cat:'study',   smiles:2, emoji:'🎓', desc:'3 ans de fac',         req:'study1', type:'life',   ext:'base' },
  { id:'study3', name:'Master',        cat:'study',   smiles:3, emoji:'🏫', desc:'Bac+5',                req:'study2', type:'life',   ext:'base' },
  { id:'study4', name:'Doctorat',      cat:'study',   smiles:4, emoji:'🔬', desc:'Docteur !',            req:'study3', type:'life',   ext:'base' },
  { id:'job1',   name:'Stagiaire',     cat:'job',     smiles:1, emoji:'☕', desc:'Galère mais ça forge', req:null,     type:'life',   ext:'base' },
  { id:'job2',   name:'Employé',       cat:'job',     smiles:2, emoji:'💼', desc:'La vie de bureau',     req:'study1', type:'life',   ext:'base' },
  { id:'job3',   name:'Manager',       cat:'job',     smiles:3, emoji:'👔', desc:'Le boss du départ.',   req:'job2',   type:'life',   ext:'base' },
  { id:'job4',   name:'Directeur',     cat:'job',     smiles:5, emoji:'🏢', desc:'Patron légendaire',    req:'job3',   type:'life',   ext:'base' },
  { id:'job5',   name:'Freelance',     cat:'job',     smiles:2, emoji:'💻', desc:'Liberté totale',       req:null,     type:'life',   ext:'base' },
  { id:'job6',   name:'Artiste',       cat:'job',     smiles:2, emoji:'🎨', desc:'La vie bohème',        req:null,     type:'life',   ext:'base' },
  { id:'job7',   name:'Influenceur',   cat:'job',     smiles:3, emoji:'📸', desc:'Des milliers d\'abonnés', req:null, type:'life',   ext:'base' },
  { id:'job8',   name:'Retraité',      cat:'job',     smiles:4, emoji:'🌴', desc:'Enfin libre !',        req:'job2',   type:'life',   ext:'base' },
  { id:'job9',   name:'Médecin',       cat:'job',     smiles:4, emoji:'🩺', desc:'On vous respecte',     req:'study3', type:'life',   ext:'base' },
  { id:'love1',  name:'Célibataire',   cat:'love',    smiles:1, emoji:'🕺', desc:'La liberté !',         req:null,     type:'life',   ext:'base' },
  { id:'love2',  name:'1er Rencard',   cat:'love',    smiles:2, emoji:'🌹', desc:'Bonne impression',     req:null,     type:'life',   ext:'base' },
  { id:'love3',  name:'En couple',     cat:'love',    smiles:3, emoji:'💑', desc:'Relation stable',      req:'love2',  type:'life',   ext:'base' },
  { id:'love4',  name:'Fiancé(e)',     cat:'love',    smiles:4, emoji:'💍', desc:'La bague !',           req:'love3',  type:'life',   ext:'base' },
  { id:'love5',  name:'Marié(e)',      cat:'love',    smiles:5, emoji:'💒', desc:'Les grands mariés',    req:'love4',  type:'life',   ext:'base' },
  { id:'fam1',   name:'Animal',        cat:'family',  smiles:2, emoji:'🐶', desc:'Trop cute',            req:null,     type:'life',   ext:'base' },
  { id:'fam2',   name:'1er enfant',    cat:'family',  smiles:3, emoji:'👶', desc:'Nuits blanches',       req:'love3',  type:'life',   ext:'base' },
  { id:'fam3',   name:'2ème enfant',   cat:'family',  smiles:4, emoji:'👫', desc:'Double dose',          req:'fam2',   type:'life',   ext:'base' },
  { id:'fam4',   name:'Grande famille',cat:'family',  smiles:6, emoji:'👨‍👩‍👧‍👦', desc:'Maison pleine !', req:'fam3', type:'life',   ext:'base' },
  { id:'home1',  name:'Colocation',    cat:'home',    smiles:1, emoji:'🏠', desc:'Location partagée',    req:null,     type:'life',   ext:'base' },
  { id:'home2',  name:'Appart loué',   cat:'home',    smiles:2, emoji:'🏡', desc:'Ton chez-toi',         req:'job1',   type:'life',   ext:'base' },
  { id:'home3',  name:'Appart acheté', cat:'home',    smiles:4, emoji:'🏘️', desc:'Propriétaire !',      req:'job2',   type:'life',   ext:'base' },
  { id:'home4',  name:'Villa',         cat:'home',    smiles:6, emoji:'🏰', desc:'Le grand luxe',        req:'job4',   type:'life',   ext:'base' },
  { id:'lei1',   name:'Voyage Europe', cat:'leisure', smiles:2, emoji:'✈️', desc:'À Paris !',            req:null,     type:'life',   ext:'base' },
  { id:'lei2',   name:'Voyage exotique', cat:'leisure', smiles:3, emoji:'🌴', desc:'Maldives dream',    req:'job2',   type:'life',   ext:'base' },
  { id:'lei3',   name:'Tour du monde', cat:'leisure', smiles:5, emoji:'🌍', desc:'L\'aventurier',        req:'job4',   type:'life',   ext:'base' },
  { id:'lei4',   name:'Voiture sport', cat:'leisure', smiles:3, emoji:'🏎️', desc:'Vroom vroom',         req:'job3',   type:'life',   ext:'base' },
  { id:'mon1',   name:'Héritage',      cat:'money',   smiles:3, emoji:'💰', desc:'Coup de bol !',        req:null,     type:'life',   ext:'base' },
  { id:'mon2',   name:'Loto gagné',    cat:'money',   smiles:4, emoji:'🎰', desc:'Jackpot !',            req:null,     type:'life',   ext:'base' },
  { id:'mon3',   name:'Investissement',cat:'money',   smiles:3, emoji:'📈', desc:'Crypto à la hausse',   req:'job2',   type:'life',   ext:'base' },
  { id:'atk1',   name:'Divorce',       cat:'attack',  smiles:-3, emoji:'💔', desc:'La catastrophe',     req:null, type:'attack', targets:'love',  ext:'base' },
  { id:'atk2',   name:'Licenciement',  cat:'attack',  smiles:-3, emoji:'📋', desc:'Bye bye le boulot',  req:null, type:'attack', targets:'job',   ext:'base' },
  { id:'atk3',   name:'Accident',      cat:'attack',  smiles:-2, emoji:'🚗', desc:'Aïe aïe aïe',        req:null, type:'attack', targets:'any',   ext:'base' },
  { id:'atk4',   name:'Dettes',        cat:'attack',  smiles:-2, emoji:'💸', desc:'Les huissiers',       req:null, type:'attack', targets:'any',   ext:'base' },
  { id:'atk5',   name:'Dépression',    cat:'attack',  smiles:-2, emoji:'😢', desc:'Coup dur',            req:null, type:'attack', targets:'any',   ext:'base' },
  { id:'atk6',   name:'Burnout',       cat:'attack',  smiles:-3, emoji:'🔥', desc:'Surmenage total',     req:null, type:'attack', targets:'job',   ext:'base' },
  { id:'atk7',   name:'Prison',        cat:'attack',  smiles:-4, emoji:'⛓️', desc:'En taule !',         req:null, type:'attack', targets:'any',   ext:'base' },
  { id:'atk8',   name:'Impôts',        cat:'attack',  smiles:-1, emoji:'📊', desc:'Merci le fisc',       req:null, type:'attack', targets:'money', ext:'base' },
  { id:'atk9',   name:'Cambriolage',   cat:'attack',  smiles:-2, emoji:'🔓', desc:'Votre maison !',      req:null, type:'attack', targets:'home',  ext:'base' },
  { id:'atk10',  name:'Trahison',      cat:'attack',  smiles:-1, emoji:'🗡️', desc:'Coup de poignard',   req:null, type:'attack', targets:'any',   ext:'base' },
  { id:'evt1',   name:'Chance ×2',     cat:'event',   smiles:0, emoji:'🍀', desc:'Piochez 2 cartes !',   req:null, type:'event',  effect:'draw2',  ext:'base' },
  { id:'evt2',   name:'Échange !',     cat:'event',   smiles:0, emoji:'🔄', desc:'Échangez une carte',   req:null, type:'event',  effect:'swap',   ext:'base' },
  { id:'evt3',   name:'Bouclier',      cat:'event',   smiles:0, emoji:'🛡️', desc:'Attaque bloquée',     req:null, type:'event',  effect:'shield', ext:'base' },
  { id:'evt4',   name:'Boost +3',      cat:'event',   smiles:0, emoji:'⚡', desc:'+3 smiles ce tour',    req:null, type:'event',  effect:'boost3', ext:'base' },
];

const CARDS_GIRL_POWER = [
  { id:'gp1',  name:'Cheffe de projet',   cat:'job',    smiles:3, emoji:'📋', desc:'Elle gère tout',         req:'study1', type:'life',   ext:'girl_power' },
  { id:'gp2',  name:'Avocate',            cat:'job',    smiles:4, emoji:'⚖️', desc:'Redoutable !',           req:'study3', type:'life',   ext:'girl_power' },
  { id:'gp3',  name:'Ministre',           cat:'job',    smiles:5, emoji:'🏛️', desc:'Au sommet du pouvoir',  req:'study3', type:'life',   ext:'girl_power' },
  { id:'gp4',  name:'Astronaute',         cat:'job',    smiles:6, emoji:'🚀', desc:'Vers les étoiles !',     req:'study4', type:'life',   ext:'girl_power' },
  { id:'gp5',  name:'Girl Boss',          cat:'job',    smiles:4, emoji:'👑', desc:'Elle dirige tout',       req:'job3',   type:'life',   ext:'girl_power' },
  { id:'gp6',  name:'Sœurs de cœur',     cat:'family', smiles:3, emoji:'👯', desc:'Les meilleures amies',   req:null,     type:'life',   ext:'girl_power' },
  { id:'gp7',  name:'Indépendance financière', cat:'money', smiles:4, emoji:'💳', desc:'Elle gère ses sous', req:'job2',   type:'life',   ext:'girl_power' },
  { id:'gp8',  name:'Égalité salariale',  cat:'event',  smiles:0, emoji:'⚖️', desc:'Double les smiles métier', req:null, type:'event', effect:'double_job', ext:'girl_power' },
  { id:'gp9',  name:'Sororité',           cat:'event',  smiles:0, emoji:'✊', desc:'Bloquez 2 attaques',     req:null, type:'event',  effect:'shield2',    ext:'girl_power' },
  { id:'gp10', name:'Mansplaining',       cat:'attack', smiles:-2, emoji:'🙄', desc:'Insupportable',         req:null, type:'attack', targets:'any',       ext:'girl_power' },
  { id:'gp11', name:'Inégalité salariale',cat:'attack', smiles:-2, emoji:'📉', desc:'Injuste !',             req:null, type:'attack', targets:'job',       ext:'girl_power' },
];

const CARDS_TRASH = [
  { id:'tr1',  name:'Addiction',      cat:'attack',  smiles:-3, emoji:'🍾', desc:'Fête trop arrosée',       req:null, type:'attack', targets:'any',    ext:'trash' },
  { id:'tr2',  name:'Rumeur',         cat:'attack',  smiles:-2, emoji:'🗣️', desc:'Tout le monde sait',     req:null, type:'attack', targets:'any',    ext:'trash' },
  { id:'tr3',  name:'Arnaque',        cat:'attack',  smiles:-3, emoji:'🎭', desc:'Dépouillé !',             req:null, type:'attack', targets:'money',  ext:'trash' },
  { id:'tr4',  name:'Scandale',       cat:'attack',  smiles:-4, emoji:'📰', desc:'En Une des journaux',     req:null, type:'attack', targets:'job',    ext:'trash' },
  { id:'tr5',  name:'Jalousie',       cat:'attack',  smiles:-2, emoji:'😤', desc:'Il t\'en veut',           req:null, type:'attack', targets:'any',    ext:'trash' },
  { id:'tr6',  name:'Procès',         cat:'attack',  smiles:-3, emoji:'🏛️', desc:'Devant le tribunal',     req:null, type:'attack', targets:'any',    ext:'trash' },
  { id:'tr7',  name:'Nuit en club',   cat:'leisure', smiles:2,  emoji:'🎉', desc:'La vraie vie !',          req:null, type:'life',   ext:'trash' },
  { id:'tr8',  name:'Road trip trash',cat:'leisure', smiles:3,  emoji:'🚐', desc:'On part en vrille',       req:null, type:'life',   ext:'trash' },
  { id:'tr9',  name:'Revanche',       cat:'event',   smiles:0,  emoji:'😈', desc:'Renvoyez une attaque',    req:null, type:'event',  effect:'reflect', ext:'trash' },
  { id:'tr10', name:'Coup du destin', cat:'event',   smiles:0,  emoji:'🎲', desc:'Volez une carte de vie',  req:null, type:'event',  effect:'steal',   ext:'trash' },
];

const CARDS_APOCALYPSE = [
  { id:'ap1',  name:'Bunker',         cat:'home',    smiles:4, emoji:'🏚️', desc:'Seul survivant',           req:null,   type:'life',   ext:'apocalypse' },
  { id:'ap2',  name:'Groupe de survie', cat:'family', smiles:5, emoji:'🧟', desc:'Ensemble on survit',      req:null,   type:'life',   ext:'apocalypse' },
  { id:'ap3',  name:'Arsenal',        cat:'leisure', smiles:3, emoji:'🔫', desc:'T\'es prêt !',             req:null,   type:'life',   ext:'apocalypse' },
  { id:'ap4',  name:'Ressources rares', cat:'money', smiles:4, emoji:'🥫', desc:'L\'or du futur',           req:null,   type:'life',   ext:'apocalypse' },
  { id:'ap5',  name:'Pandémie',       cat:'attack',  smiles:-3, emoji:'🦠', desc:'Touche tout le monde',    req:null, type:'attack', targets:'any',    ext:'apocalypse' },
  { id:'ap6',  name:'Météorite',      cat:'attack',  smiles:-4, emoji:'☄️', desc:'Catastrophe totale',     req:null, type:'attack', targets:'any',    ext:'apocalypse' },
  { id:'ap7',  name:'Panne électrique', cat:'attack', smiles:-2, emoji:'🔌', desc:'Tout s\'arrête',         req:null, type:'attack', targets:'job',    ext:'apocalypse' },
  { id:'ap8',  name:'Pillage',        cat:'attack',  smiles:-3, emoji:'💣', desc:'Tout est volé',           req:null, type:'attack', targets:'home',   ext:'apocalypse' },
  { id:'ap9',  name:'Résilience',     cat:'event',   smiles:0,  emoji:'💪', desc:'+4 smiles instantanés',   req:null, type:'event',  effect:'boost4',  ext:'apocalypse' },
  { id:'ap10', name:'Alliance',       cat:'event',   smiles:0,  emoji:'🤝', desc:'Protège un allié',        req:null, type:'event',  effect:'shield',  ext:'apocalypse' },
];

const CARDS_VIE_DE_LUXE = [
  { id:'vdl1', name:'Jet privé',      cat:'leisure', smiles:5, emoji:'✈️', desc:'Au-dessus des nuages',     req:'job4',  type:'life',   ext:'vie_de_luxe' },
  { id:'vdl2', name:'Yacht de luxe',  cat:'leisure', smiles:6, emoji:'⛵', desc:'Navigation privée',        req:'job4',  type:'life',   ext:'vie_de_luxe' },
  { id:'vdl3', name:'Château',        cat:'home',    smiles:7, emoji:'🏯', desc:'Vrai aristocrate',         req:'job4',  type:'life',   ext:'vie_de_luxe' },
  { id:'vdl4', name:'Garde du corps', cat:'event',   smiles:0, emoji:'🕵️', desc:'Bloquez 3 attaques',      req:null,    type:'event',  effect:'shield3', ext:'vie_de_luxe' },
  { id:'vdl5', name:'VIP',            cat:'job',     smiles:5, emoji:'🌟', desc:'Accès partout',            req:'job3',  type:'life',   ext:'vie_de_luxe' },
  { id:'vdl6', name:'Collection d\'art', cat:'money', smiles:5, emoji:'🖼️', desc:'Investissement malin',   req:'mon1',  type:'life',   ext:'vie_de_luxe' },
  { id:'vdl7', name:'Paparazzi',      cat:'attack',  smiles:-2, emoji:'📷', desc:'Vie privée brisée',       req:null, type:'attack', targets:'any',    ext:'vie_de_luxe' },
  { id:'vdl8', name:'Fisc international', cat:'attack', smiles:-4, emoji:'🌐', desc:'Tout saisi !',         req:null, type:'attack', targets:'money',  ext:'vie_de_luxe' },
];

const CARDS_FANTASTIQUE = [
  { id:'ft1',  name:'Sorcier',        cat:'job',     smiles:4, emoji:'🧙', desc:'Magie noire & blanche',    req:null,   type:'life',   ext:'fantastique' },
  { id:'ft2',  name:'Dragon apprivoisé', cat:'family', smiles:5, emoji:'🐉', desc:'Meilleur ami',           req:null,   type:'life',   ext:'fantastique' },
  { id:'ft3',  name:'Château hanté',  cat:'home',    smiles:3, emoji:'👻', desc:'Ambiance garantie',        req:null,   type:'life',   ext:'fantastique' },
  { id:'ft4',  name:'Artefact magique', cat:'money',  smiles:4, emoji:'🔮', desc:'Valeur inestimable',      req:null,   type:'life',   ext:'fantastique' },
  { id:'ft5',  name:'Malédiction',    cat:'attack',  smiles:-3, emoji:'💀', desc:'Malheur sur toi !',       req:null, type:'attack', targets:'any',    ext:'fantastique' },
  { id:'ft6',  name:'Sortilège',      cat:'attack',  smiles:-2, emoji:'⚡', desc:'Perd une carte vie',      req:null, type:'attack', targets:'any',    ext:'fantastique' },
  { id:'ft7',  name:'Potion de bonheur', cat:'event', smiles:0, emoji:'🧪', desc:'+5 smiles !',             req:null, type:'event',  effect:'boost5',  ext:'fantastique' },
  { id:'ft8',  name:'Téléportation',  cat:'event',   smiles:0, emoji:'🌀', desc:'Échangez vos mains',       req:null, type:'event',  effect:'swap_hands', ext:'fantastique' },
];

const ALL_CARDS = [...CARDS_BASE,...CARDS_GIRL_POWER,...CARDS_TRASH,...CARDS_APOCALYPSE,...CARDS_VIE_DE_LUXE,...CARDS_FANTASTIQUE];
const CARD_MAP  = Object.fromEntries(ALL_CARDS.map(c => [c.id, c]));

const DECK_TEMPLATES = {
  base: [
    'study1','study1','study2','study2','study3','study4',
    'job1','job1','job2','job2','job3','job3','job4','job5','job5','job6','job6','job7','job8','job9',
    'love1','love2','love2','love3','love3','love4','love5',
    'fam1','fam1','fam2','fam3','fam4',
    'home1','home1','home2','home2','home3','home4',
    'lei1','lei1','lei2','lei2','lei3','lei4',
    'mon1','mon2','mon3',
    'atk1','atk2','atk3','atk3','atk4','atk4','atk5','atk5','atk6','atk7','atk8','atk8','atk9','atk10',
    'evt1','evt1','evt2','evt3','evt3','evt4','evt4',
  ],
  girl_power:  ['gp1','gp2','gp3','gp4','gp5','gp6','gp7','gp8','gp8','gp9','gp9','gp10','gp10','gp10','gp11','gp11'],
  trash:       ['tr1','tr2','tr3','tr4','tr5','tr6','tr7','tr7','tr8','tr8','tr9','tr9','tr10','tr10'],
  apocalypse:  ['ap1','ap2','ap3','ap4','ap5','ap5','ap6','ap7','ap7','ap8','ap8','ap9','ap9','ap10','ap10'],
  vie_de_luxe: ['vdl1','vdl2','vdl3','vdl4','vdl5','vdl6','vdl7','vdl7','vdl8','vdl8'],
  fantastique: ['ft1','ft2','ft3','ft4','ft5','ft5','ft6','ft6','ft7','ft7','ft8','ft8'],
};

const EXT_INFO = {
  base:        { name:'Jeu de base',  emoji:'🎮', desc:'200 cartes — la vie classique' },
  girl_power:  { name:'Girl Power',   emoji:'👑', desc:'60 cartes — liberté, égalité, sororité' },
  trash:       { name:'Trash',        emoji:'🔥', desc:'55 cartes — humour décapant (16+)' },
  apocalypse:  { name:'Apocalypse',   emoji:'☄️', desc:'60 cartes — survivre à la fin du monde' },
  vie_de_luxe: { name:'Vie de Luxe',  emoji:'💎', desc:'60 cartes — bling-bling & jet-set' },
  fantastique: { name:'Fantastique',  emoji:'🧙', desc:'60 cartes — magie & créatures' },
};

// ══════════════════════════════════════════════════════════
//  Logique de jeu
// ══════════════════════════════════════════════════════════
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rooms  = {};
const EMOJIS = ['😄','🤩','🎭','🦸','🧙','🤠'];

function buildDeck(exts) {
  const ids = [];
  for (const e of exts) if (DECK_TEMPLATES[e]) ids.push(...DECK_TEMPLATES[e]);
  return shuffle(ids.map(id => ({ ...CARD_MAP[id], uid: crypto.randomBytes(4).toString('hex') })));
}

function createRoom() {
  let code;
  do { code = Math.random().toString(36).slice(2,6).toUpperCase(); } while (rooms[code]);
  rooms[code] = { code, phase:'lobby', extensions:['base'], players:[], deck:[], currentIdx:0, hasPlayed:false, log:[] };
  return code;
}

function addPlayer(room, name, socket) {
  const p = { id:crypto.randomUUID(), name, emoji:EMOJIS[room.players.length%6], socket, hand:[], life:[], shielded:0, boost:0, reflect:false };
  room.players.push(p);
  return p;
}

function countSmiles(p) {
  return Math.max(0, p.life.reduce((s,c) => s+(c.smiles||0), 0) + (p.boost||0));
}

function addLog(room, msg, kind='') {
  room.log.unshift({ msg, kind });
  if (room.log.length > 25) room.log.pop();
}

function publicState(room) {
  return {
    code:room.code, phase:room.phase, extensions:room.extensions,
    currentIdx:room.currentIdx, hasPlayed:room.hasPlayed, deckCount:room.deck.length,
    players: room.players.map(p => ({
      id:p.id, name:p.name, emoji:p.emoji, smiles:countSmiles(p),
      life:p.life, shielded:p.shielded, handCount:p.hand.length,
    })),
    log: room.log.slice(0,12),
  };
}

function broadcast(room, msg)    { room.players.forEach(p => wsSend(p.socket, msg)); }
function broadcastState(room)    { const pub = publicState(room); room.players.forEach(p => wsSend(p.socket,{type:'state',state:pub,myId:p.id,myHand:p.hand})); }
function sendErr(player, msg)    { wsSend(player.socket, { type:'error', msg }); }

function drawCard(room, idx) {
  if (!room.deck.length) return false;
  room.players[idx].hand.push(room.deck.pop());
  return true;
}

function startGame(room) {
  room.deck = buildDeck(room.extensions);
  room.phase = 'playing'; room.currentIdx = 0; room.hasPlayed = false;
  room.players.forEach((p,i) => { p.hand=[]; p.life=[]; p.shielded=0; p.boost=0; p.reflect=false; for(let j=0;j<5;j++) drawCard(room,i); });
  addLog(room, `🎲 Partie lancée ! ${room.extensions.map(e=>EXT_INFO[e].emoji+' '+EXT_INFO[e].name).join(', ')}`, 'info');
  startTurn(room);
}

function startTurn(room) {
  room.hasPlayed = false;
  const p = room.players[room.currentIdx];
  p.boost = 0;
  if (!drawCard(room, room.currentIdx)) { endGame(room); return; }
  while (p.hand.length > 6) p.hand.shift();
  addLog(room, `${p.emoji} ${p.name} — c'est ton tour !`, 'info');
  broadcastState(room);
}

function endGame(room) {
  room.phase = 'ended';
  const scores = room.players.map(p=>({name:p.name,emoji:p.emoji,smiles:countSmiles(p)})).sort((a,b)=>b.smiles-a.smiles);
  addLog(room, `🏆 Fin ! Gagnant : ${scores[0].emoji} ${scores[0].name} (${scores[0].smiles} 😊)`, 'info');
  broadcast(room, { type:'gameover', scores });
  broadcastState(room);
}

function applyEvent(room, player, pidx, card) {
  const e = card.effect;
  if (e==='draw2') { drawCard(room,pidx); drawCard(room,pidx); addLog(room,`${player.emoji} ${player.name} pioche 2 cartes 🍀`,'good'); }
  else if (e==='shield')  { player.shielded=(player.shielded||0)+1; addLog(room,`${player.emoji} ${player.name} active un bouclier 🛡️`,'good'); }
  else if (e==='shield2') { player.shielded=(player.shielded||0)+2; addLog(room,`${player.emoji} ${player.name} active 2 boucliers 🛡️🛡️`,'good'); }
  else if (e==='shield3') { player.shielded=(player.shielded||0)+3; addLog(room,`${player.emoji} ${player.name} active 3 boucliers 🛡️🛡️🛡️`,'good'); }
  else if (e==='boost3')  { player.boost=(player.boost||0)+3; addLog(room,`${player.emoji} ${player.name} boost +3 ⚡`,'good'); }
  else if (e==='boost4')  { player.boost=(player.boost||0)+4; addLog(room,`${player.emoji} ${player.name} boost +4 ⚡⚡`,'good'); }
  else if (e==='boost5')  { player.boost=(player.boost||0)+5; addLog(room,`${player.emoji} ${player.name} potion +5 🧪`,'good'); }
  else if (e==='double_job') { player.life.filter(c=>c.cat==='job').forEach(c=>{c.smiles*=2;}); addLog(room,`${player.emoji} ${player.name} double ses smiles métier ⚖️`,'good'); }
  else if (e==='reflect') { player.reflect=true; addLog(room,`${player.emoji} ${player.name} prépare une revanche 😈`,'info'); }
  else if (e==='steal') {
    const others=room.players.filter((_,i)=>i!==pidx&&room.players[i].life.length>0);
    if (others.length) { const t=others[Math.floor(Math.random()*others.length)]; const s=t.life.splice(Math.floor(Math.random()*t.life.length),1)[0]; player.life.push(s); addLog(room,`😈 ${player.name} vole "${s.name}" à ${t.name} !`,'bad'); }
  }
  else if (e==='swap') {
    const others=room.players.filter((_,i)=>i!==pidx&&room.players[i].life.length>0);
    if (others.length&&player.life.length) { const t=others[Math.floor(Math.random()*others.length)]; const mc=player.life.splice(Math.floor(Math.random()*player.life.length),1)[0]; const tc=t.life.splice(Math.floor(Math.random()*t.life.length),1)[0]; player.life.push(tc); t.life.push(mc); addLog(room,`🔄 ${player.name} échange "${mc.name}" ↔ "${tc.name}" (${t.name})`,'info'); }
  }
  else if (e==='swap_hands') {
    const others=room.players.filter((_,i)=>i!==pidx);
    if (others.length) { const t=others[Math.floor(Math.random()*others.length)]; const tmp=player.hand; player.hand=t.hand; t.hand=tmp; addLog(room,`🌀 ${player.name} échange sa main avec ${t.name} !`,'info'); }
  }
}

function doAttack(room, attacker, card, target) {
  let removed=null;
  if (card.targets!=='any') { const i=target.life.findIndex(c=>c.cat===card.targets); if(i!==-1) removed=target.life.splice(i,1)[0]; }
  if (!removed&&target.life.length>0) removed=target.life.splice(Math.floor(Math.random()*target.life.length),1)[0];
  addLog(room, removed ? `${attacker.emoji} ${attacker.name} ⚔️ ${target.emoji} ${target.name} — "${removed.name}" retirée !` : `${attacker.emoji} ${attacker.name} ⚔️ ${target.emoji} ${target.name} — rien à retirer`, 'bad');
}

function handleAction(room, player, msg) {
  if (room.phase!=='playing') return;
  const pidx = room.players.indexOf(player);

  if (msg.action==='playCard') {
    if (pidx!==room.currentIdx) return sendErr(player,'Pas ton tour !');
    if (room.hasPlayed)          return sendErr(player,'Tu as déjà joué !');
    const card = player.hand.find(c=>c.uid===msg.uid);
    if (!card) return;
    if (card.type==='life') {
      if (card.req && !player.life.some(c=>c.id===card.req)) { const n=CARD_MAP[card.req]; return sendErr(player,`Besoin de "${n?n.name:card.req}" d'abord !`); }
      player.hand=player.hand.filter(c=>c.uid!==card.uid); player.life.push(card); room.hasPlayed=true;
      addLog(room,`${player.emoji} ${player.name} pose "${card.name}" (+${card.smiles} 😊)`,'good'); broadcastState(room);
    } else if (card.type==='event') {
      player.hand=player.hand.filter(c=>c.uid!==card.uid); room.hasPlayed=true;
      applyEvent(room,player,pidx,card); broadcastState(room);
    } else if (card.type==='attack') {
      wsSend(player.socket,{type:'needTarget',uid:card.uid});
    }
  }
  else if (msg.action==='attackTarget') {
    if (pidx!==room.currentIdx||room.hasPlayed) return;
    const card=player.hand.find(c=>c.uid===msg.uid); const target=room.players.find(p=>p.id===msg.targetId);
    if (!card||!target||target===player) return;
    player.hand=player.hand.filter(c=>c.uid!==card.uid); room.hasPlayed=true;
    if (target.reflect) { target.reflect=false; doAttack(room,player,card,player); addLog(room,`😈 ${target.name} renvoie l'attaque sur ${player.name} !`,'bad'); }
    else if (target.shielded>0) { target.shielded--; addLog(room,`🛡️ ${target.name} bloque l'attaque de ${player.name} !`,'info'); }
    else { doAttack(room,player,card,target); }
    broadcastState(room);
  }
  else if (msg.action==='discard') {
    if (pidx!==room.currentIdx||room.hasPlayed) return;
    const card=player.hand.find(c=>c.uid===msg.uid); if (!card) return;
    player.hand=player.hand.filter(c=>c.uid!==card.uid); room.hasPlayed=true;
    addLog(room,`${player.emoji} ${player.name} défausse "${card.name}"`,'info'); broadcastState(room);
  }
  else if (msg.action==='endTurn') {
    if (pidx!==room.currentIdx) return;
    if (!room.hasPlayed) return sendErr(player,'Joue ou défausse une carte d\'abord !');
    room.currentIdx=(room.currentIdx+1)%room.players.length;
    if (!room.deck.length) { endGame(room); return; }
    startTurn(room);
  }
  else if (msg.action==='toggleExtension') {
    if (room.phase!=='lobby'||pidx!==0) return;
    const ext=msg.ext; if (ext==='base'||!EXT_INFO[ext]) return;
    const i=room.extensions.indexOf(ext);
    if (i===-1) room.extensions.push(ext); else room.extensions.splice(i,1);
    broadcastState(room);
  }
}

// ══════════════════════════════════════════════════════════
//  Serveur HTTP + WebSocket
// ══════════════════════════════════════════════════════════
const CLIENT_HTML = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');

const server = http.createServer((req, res) => {
  if (req.method==='GET' && (req.url==='/'||req.url==='/index.html')) {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(CLIENT_HTML);
  } else { res.writeHead(404); res.end('Not found'); }
});

server.on('upgrade', (req, socket) => {
  wsHandshake(req, socket);
  let player=null, room=null, buf=Buffer.alloc(0);

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, remaining } = wsParse(buf);
    buf = remaining; // ← fix critique : on garde les données partielles

    for (const msg of messages) {
      if (msg===null) { socket.destroy(); return; }
      try {
        if (msg.type==='create') {
          const code=createRoom(); room=rooms[code]; player=addPlayer(room,msg.name,socket);
          wsSend(socket,{type:'joined',code,playerId:player.id,isHost:true,extInfo:EXT_INFO});
          broadcastState(room);
        }
        else if (msg.type==='join') {
          const r=rooms[msg.code];
          if (!r)                    return wsSend(socket,{type:'error',msg:'Salon introuvable !'});
          if (r.phase!=='lobby')     return wsSend(socket,{type:'error',msg:'Partie déjà en cours !'});
          if (r.players.length>=6)   return wsSend(socket,{type:'error',msg:'Salon plein !'});
          room=r; player=addPlayer(room,msg.name,socket);
          wsSend(socket,{type:'joined',code:room.code,playerId:player.id,isHost:false,extInfo:EXT_INFO});
          addLog(room,`${player.emoji} ${player.name} rejoint la partie !`,'info');
          broadcastState(room);
        }
        else if (msg.type==='start') {
          if (!room||room.phase!=='lobby') return;
          if (room.players.length<2) return wsSend(socket,{type:'error',msg:'Il faut au moins 2 joueurs !'});
          startGame(room);
        }
        else if (msg.type==='toggleExtension') {
          // Accessible depuis le lobby directement (pas besoin de phase playing)
          if (!room||!player) return;
          const pidx = room.players.indexOf(player);
          if (room.phase!=='lobby'||pidx!==0) return;
          const ext = msg.ext;
          if (ext==='base'||!EXT_INFO[ext]) return;
          const i = room.extensions.indexOf(ext);
          if (i===-1) room.extensions.push(ext); else room.extensions.splice(i,1);
          broadcastState(room);
        }
        else if (msg.type==='chat') {
          if (!room||!player) return;
          const text = (msg.text||'').trim().slice(0,200);
          if (!text) return;
          broadcast(room, { type:'chat', from:player.name, emoji:player.emoji, text });
        }
        else if (msg.type==='action') { if (room&&player) handleAction(room,player,msg); }
      } catch(err) { console.error('Err msg:',err); }
    }
  });

  socket.on('close', () => { if(player&&room){addLog(room,`${player.emoji} ${player.name} s'est déconnecté(e)`,'bad'); player.socket=null; broadcastState(room);} });
  socket.on('error', ()=>{});
});

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const addr of iface)
      if (addr.family==='IPv4'&&!addr.internal) return addr.address;
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const isCloud = !!process.env.RENDER || !!process.env.RAILWAY_ENVIRONMENT;
  const ip = getLocalIP();
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       😊  SmileLife                  ║');
  console.log('╠══════════════════════════════════════╣');
  if (isCloud) {
    console.log(`║  ☁️  Hébergé sur le cloud             ║`);
    console.log(`║  Port : ${String(PORT).padEnd(29)}║`);
  } else {
    console.log(`║  👉  http://${ip}:${PORT}            ║`);
    console.log(`║  Même réseau Wi-Fi requis             ║`);
  }
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Extensions disponibles :             ║');
  Object.values(EXT_INFO).forEach(v => console.log(`║  ${v.emoji} ${v.name.padEnd(33)}║`));
  console.log('╚══════════════════════════════════════╝\n');
});
