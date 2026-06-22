/**
 * ============================================
 * SCRIPT.JS — Moteur d'Animation Multimedia
 * "Un Jour à l'IUT" — Projet IUT Bandjoun 2026
 * Auteurs : Foapa Gianny & Tiemdjo Ryan
 * ============================================
 *
 * Architecture :
 *  0. Utilitaires SVG & état global
 *  1. Moteur Audio (Web Audio API — ambiances et effets sonores synthétisés, sans fichier externe)
 *  2. Classe Character — personnages SVG animés
 *  3. Classe SpeechBubble + helper say() — dialogues avec sous-titres et durée auto
 *  4. Décors — fonds de scène détaillés (campus, dortoir, classe, bibliothèque, bureau, studio)
 *  5. Effets visuels — particules, clignotements, vol d'objets vers les bacs de tri
 *  6. Scènes — Scène 0 (intro) + 4 scènes interactives
 *  7. Navigation — sélecteur de scène, bouton "Passer", chargement
 *  8. Initialisation
 *
 * Règle de cohérence des animations (important) :
 *  - La position d'un personnage ou d'un décor est TOUJOURS pilotée par
 *    l'attribut SVG `transform`, modifié en JavaScript (jamais par une
 *    classe CSS animée). Cela évite tout conflit entre la position et
 *    une animation CSS qui ciblerait aussi `transform`.
 *  - Les animations locales (jambes, bras, bulles, particules) ne
 *    s'appliquent qu'à des éléments qui n'ont pas d'attribut transform
 *    positionnel propre.
 */

// ============================================
// 0. UTILITAIRES SVG & ÉTAT GLOBAL
// ============================================

function svgEl(tag, attrs, parent) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    attrs = attrs || {};
    for (const key in attrs) {
        if (key === 'text') { el.textContent = attrs[key]; continue; }
        el.setAttribute(key, attrs[key]);
    }
    if (parent) parent.appendChild(el);
    return el;
}

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const LAYERS = {
    bg: () => document.getElementById('background-layer'),
    char: () => document.getElementById('character-layer'),
    bubble: () => document.getElementById('speech-bubble-layer'),
    fx: () => document.getElementById('effect-layer'),
    ui: () => document.getElementById('ui-layer')
};

const STATE = {
    currentScene: null,
    isAnimating: false,
    skipScene: false,
    soundEnabled: true,
    musicEnabled: true,
    characters: [],
    pendingDelays: []
};

const VOICES_CONFIG = {
    kevin: { gender: 'male', pitch: 1.0, rate: 0.98 },
    nadia: { gender: 'female', pitch: 1.25, rate: 1.0 },
    brice: { gender: 'male', pitch: 0.85, rate: 1.02 },
    aline: { gender: 'female', pitch: 1.15, rate: 0.97 },
    junior: { gender: 'male', pitch: 0.95, rate: 1.0 },
    carine: { gender: 'female', pitch: 1.2, rate: 0.98 },
    eleve1: { gender: 'male', pitch: 1.05, rate: 1.0 },
    eleve2: { gender: 'female', pitch: 1.18, rate: 0.98 },
    tchoumi: { gender: 'male', pitch: 0.75, rate: 0.92 },
    recruteur: { gender: 'male', pitch: 0.9, rate: 0.95 },
    candidat2: { gender: 'male', pitch: 1.05, rate: 1.05 },
    presenter: { gender: 'male', pitch: 1.0, rate: 0.95 },
    professeur: { gender: 'female', pitch: 1.2, rate: 0.93 }
};

function delay(ms) {
    return new Promise(resolve => {
        if (STATE.skipScene) { resolve(); return; }
        const entry = { resolve, timeoutId: null };
        entry.timeoutId = setTimeout(() => {
            STATE.pendingDelays = STATE.pendingDelays.filter(e => e !== entry);
            resolve();
        }, ms);
        STATE.pendingDelays.push(entry);
    });
}

async function ensureMinDuration(startTime, minMs) {
    const remaining = minMs - (Date.now() - startTime);
    if (remaining > 0) await delay(remaining);
}

function requestSkip() {
    if (!STATE.isAnimating || STATE.skipScene) return;
    STATE.skipScene = true;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    AudioEngine.stopAmbient();
    const pending = STATE.pendingDelays.slice();
    STATE.pendingDelays = [];
    pending.forEach(entry => {
        clearTimeout(entry.timeoutId);
        entry.resolve();
    });
}

function clearScene() {
    ['background-layer', 'character-layer', 'speech-bubble-layer', 'effect-layer'].forEach(id => {
        document.getElementById(id).innerHTML = '';
    });
    STATE.characters = [];
}

function setBackground(group) {
    group.classList.add('scene-fade-in');
    LAYERS.bg().appendChild(group);
}

function presentCharacters(...chars) {
    chars.forEach(c => { if (!c.group.parentNode) LAYERS.char().appendChild(c.group); });
    return chars;
}

// ============================================
// 1. MOTEUR AUDIO — Web Audio API (synthèse, aucun fichier externe)
// ============================================

const AudioEngine = (() => {
    let ctx = null;
    let ambientGain = null;
    let sfxGain = null;
    let ambientHandle = null;

    function ensureCtx() {
        try {
            if (!ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                ctx = new AC();
                ambientGain = ctx.createGain();
                ambientGain.gain.value = STATE.musicEnabled ? 0.3 : 0;
                ambientGain.connect(ctx.destination);
                sfxGain = ctx.createGain();
                sfxGain.gain.value = STATE.soundEnabled ? 0.45 : 0;
                sfxGain.connect(ctx.destination);
            }
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            return ctx;
        } catch (e) {
            return null;
        }
    }

    function setAmbientEnabled(on) {
        const c = ensureCtx();
        if (!c || !ambientGain) return;
        ambientGain.gain.setTargetAtTime(on ? 0.3 : 0, c.currentTime, 0.08);
    }

    function setSfxEnabled(on) {
        const c = ensureCtx();
        if (!c || !sfxGain) return;
        sfxGain.gain.setTargetAtTime(on ? 0.45 : 0, c.currentTime, 0.08);
    }

    function noiseBuffer(seconds) {
        const c = ensureCtx();
        if (!c) return null;
        const buffer = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        return buffer;
    }

    function stopAmbient() {
        if (ambientHandle) { ambientHandle.stop(); ambientHandle = null; }
    }

    function startAmbient(type) {
        stopAmbient();
        const c = ensureCtx();
        if (!c) return;
        const cleanups = [];

        function addNoise(freq, ftype, vol) {
            const src = c.createBufferSource();
            const buf = noiseBuffer(3);
            if (!buf) return;
            src.buffer = buf;
            src.loop = true;
            const filter = c.createBiquadFilter();
            filter.type = ftype;
            filter.frequency.value = freq;
            const gain = c.createGain();
            gain.gain.value = vol;
            src.connect(filter); filter.connect(gain); gain.connect(ambientGain);
            src.start();
            cleanups.push(() => {
                try { src.stop(); } catch (e) {}
                try { src.disconnect(); } catch (e) {}
                try { gain.disconnect(); } catch (e) {}
            });
        }

        function addDrone(freq, vol) {
            const osc = c.createOscillator();
            const gain = c.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.value = vol;
            osc.connect(gain); gain.connect(ambientGain);
            osc.start();
            cleanups.push(() => {
                try { osc.stop(); } catch (e) {}
                try { osc.disconnect(); } catch (e) {}
                try { gain.disconnect(); } catch (e) {}
            });
        }

        function addRepeatingChirp(minMs, maxMs) {
            let stopped = false, timeoutId = null;
            const fire = () => {
                if (stopped) return;
                const t = c.currentTime;
                const osc = c.createOscillator();
                const g = c.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(1800 + Math.random() * 800, t);
                osc.frequency.exponentialRampToValueAtTime(2400 + Math.random() * 1000, t + 0.08);
                g.gain.setValueAtTime(0.0001, t);
                g.gain.linearRampToValueAtTime(0.1, t + 0.02);
                g.gain.linearRampToValueAtTime(0.0001, t + 0.18);
                osc.connect(g); g.connect(ambientGain);
                osc.start(t); osc.stop(t + 0.2);
                timeoutId = setTimeout(fire, minMs + Math.random() * (maxMs - minMs));
            };
            timeoutId = setTimeout(fire, minMs + Math.random() * (maxMs - minMs));
            cleanups.push(() => { stopped = true; if (timeoutId) clearTimeout(timeoutId); });
        }

        function addArpeggioLoop(notes, stepMs) {
            let stopped = false, timeoutId = null, i = 0;
            const playNote = () => {
                if (stopped) return;
                const t = c.currentTime;
                const osc = c.createOscillator();
                const g = c.createGain();
                osc.type = 'triangle';
                osc.frequency.value = notes[i % notes.length];
                g.gain.setValueAtTime(0.0001, t);
                g.gain.linearRampToValueAtTime(0.07, t + 0.05);
                g.gain.linearRampToValueAtTime(0.0001, t + 0.5);
                osc.connect(g); g.connect(ambientGain);
                osc.start(t); osc.stop(t + 0.55);
                i++;
                timeoutId = setTimeout(playNote, stepMs);
            };
            timeoutId = setTimeout(playNote, 400);
            cleanups.push(() => { stopped = true; if (timeoutId) clearTimeout(timeoutId); });
        }

        switch (type) {
            case 'campus':
                addNoise(900, 'lowpass', 0.05);
                addRepeatingChirp(1800, 4500);
                break;
            case 'dorm':
                addNoise(300, 'lowpass', 0.022);
                break;
            case 'classroom':
                addNoise(500, 'lowpass', 0.03);
                break;
            case 'library':
                addNoise(250, 'lowpass', 0.016);
                break;
            case 'recycling-cheerful':
                addNoise(900, 'lowpass', 0.035);
                addRepeatingChirp(2000, 5000);
                addArpeggioLoop([523.25, 659.25, 783.99, 1046.5], 650);
                break;
            case 'office':
                addNoise(180, 'lowpass', 0.018);
                addDrone(60, 0.01);
                break;
            case 'studio':
                addDrone(110, 0.02);
                addDrone(165, 0.018);
                break;
            default:
                addNoise(400, 'lowpass', 0.02);
        }

        ambientHandle = { stop: () => cleanups.forEach(fn => fn()) };
    }

    function blip(freq, duration, type, vol) {
        const c = ensureCtx();
        if (!c || !sfxGain) return;
        const t = c.currentTime;
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        osc.connect(g); g.connect(sfxGain);
        osc.start(t);
        osc.stop(t + duration + 0.02);
    }

    function playChime() {
        if (!STATE.soundEnabled) return;
        blip(880, 0.25, 'sine', 0.2);
        setTimeout(() => blip(1320, 0.3, 'sine', 0.15), 120);
    }

    function playAlertCrash() {
        if (!STATE.soundEnabled) return;
        blip(220, 0.4, 'sawtooth', 0.18);
        setTimeout(() => blip(160, 0.4, 'sawtooth', 0.15), 150);
    }

    function playThunk() {
        if (!STATE.soundEnabled) return;
        blip(140, 0.18, 'square', 0.12);
    }

    function playDing() {
        if (!STATE.soundEnabled) return;
        blip(1500, 0.2, 'sine', 0.12);
    }

    function playTyping(count) {
        if (!STATE.soundEnabled) return;
        for (let i = 0; i < (count || 5); i++) {
            setTimeout(() => blip(700 + Math.random() * 700, 0.03, 'square', 0.05), i * 90);
        }
    }

    function playAlarmBeep(times) {
        if (!STATE.soundEnabled) return;
        for (let i = 0; i < (times || 4); i++) {
            setTimeout(() => blip(1000, 0.15, 'square', 0.18), i * 350);
        }
    }

    return {
        ensureCtx, startAmbient, stopAmbient, setAmbientEnabled, setSfxEnabled,
        playChime, playAlertCrash, playThunk, playDing, playTyping, playAlarmBeep
    };
})();

// ============================================
// 2. CLASSE CHARACTER — Personnage SVG animé
// ============================================

let cachedVoices = [];
function refreshVoiceCache() {
    try { cachedVoices = window.speechSynthesis.getVoices() || []; } catch (e) { cachedVoices = []; }
}

function pickFrenchVoice(gender) {
    if (!cachedVoices.length) refreshVoiceCache();
    const frVoices = cachedVoices.filter(v => v.lang && v.lang.toLowerCase().startsWith('fr'));
    if (!frVoices.length) return null;
    const femaleHints = ['amelie', 'amélie', 'audrey', 'virginie', 'celine', 'céline', 'marie', 'female', 'hortense'];
    const maleHints = ['thomas', 'nicolas', 'male', 'daniel', 'henri'];
    const hints = gender === 'female' ? femaleHints : maleHints;
    const match = frVoices.find(v => hints.some(h => v.name.toLowerCase().includes(h)));
    return match || frVoices[0];
}

class Character {
    constructor(x, y, name, opts) {
        opts = opts || {};
        this.x = x;
        this.y = y;
        this.name = name;
        this.skinColor = opts.skin || '#F4A460';
        this.shirtColor = opts.shirt || '#3D6EDB';
        this.hair = opts.hair || 'short-dark';
        this.accessory = opts.accessory || null;
        this.facing = 1;
        this.isSpeaking = false;

        this.group = svgEl('g', { transform: `translate(${x}, ${y})`, class: 'character' });
        this.body = svgEl('g', {}, this.group);
        this.buildSVG();
        STATE.characters.push(this);
    }

    applyBodyTransform(extra) {
        const t = `scale(${this.facing},1) ${extra || ''}`.trim();
        this.body.setAttribute('transform', t);
    }

    buildSVG() {
        const g = this.body;

        svgEl('ellipse', { cx: 0, cy: 55, rx: 28, ry: 8, fill: 'rgba(0,0,0,0.15)' }, g);

        [-1, 1].forEach(i => {
            svgEl('line', { x1: i * 8, y1: 30, x2: i * 8, y2: 52, stroke: '#333', 'stroke-width': 6, 'stroke-linecap': 'round', id: `leg-${i}-${this.name}` }, g);
            svgEl('ellipse', { cx: i * 8, cy: 55, rx: 7, ry: 5, fill: '#1a1a1a' }, g);
        });

        svgEl('rect', { x: -18, y: -8, width: 36, height: 38, rx: 4, fill: this.shirtColor, stroke: '#333', 'stroke-width': 2 }, g);

        [-1, 1].forEach(i => {
            svgEl('line', { x1: i * 18, y1: -2, x2: i * 42, y2: 8, stroke: this.skinColor, 'stroke-width': 6, 'stroke-linecap': 'round', id: `arm-${i}-${this.name}` }, g);
            svgEl('circle', { cx: i * 42, cy: 8, r: 6, fill: this.skinColor, stroke: '#333', 'stroke-width': 1 }, g);
        });

        svgEl('circle', { cx: 0, cy: -40, r: 28, fill: this.skinColor, stroke: '#333', 'stroke-width': 2 }, g);

        this.buildHair(g);

        [-1, 1].forEach(i => {
            svgEl('circle', { cx: i * 10, cy: -48, r: 6, fill: '#FFF', stroke: '#333', 'stroke-width': 1 }, g);
            svgEl('circle', { cx: i * 10, cy: -48, r: 3, fill: '#000', id: `pupil-${i}-${this.name}` }, g);
        });

        svgEl('ellipse', { cx: 0, cy: -28, rx: 10, ry: 4, fill: '#FF6B9D', stroke: '#333', 'stroke-width': 1, id: `mouth-${this.name}` }, g);

        if (this.accessory === 'glasses') {
            svgEl('rect', { x: -16, y: -52, width: 12, height: 9, rx: 2, fill: 'none', stroke: '#222', 'stroke-width': 2 }, g);
            svgEl('rect', { x: 4, y: -52, width: 12, height: 9, rx: 2, fill: 'none', stroke: '#222', 'stroke-width': 2 }, g);
            svgEl('line', { x1: -4, y1: -48, x2: 4, y2: -48, stroke: '#222', 'stroke-width': 2 }, g);
        } else if (this.accessory === 'tie') {
            svgEl('polygon', { points: '-4,-6 4,-6 6,4 0,12 -6,4', fill: '#B22222' }, g);
        } else if (this.accessory === 'cap') {
            svgEl('path', { d: 'M -26,-58 Q 0,-78 26,-58 L 26,-50 L -26,-50 Z', fill: '#2F4F4F' }, g);
        }
    }

    buildHair(g) {
        const dark = '#1a1a1a', brown = '#4A2C17', light = '#D9B98A';
        if (this.hair === 'short-dark' || this.hair === 'short-brown') {
            svgEl('path', { d: 'M -28,-44 Q -28,-70 0,-70 Q 28,-70 28,-44 Q 20,-58 0,-58 Q -20,-58 -28,-44 Z', fill: this.hair === 'short-dark' ? dark : brown }, g);
        } else if (this.hair === 'long-dark' || this.hair === 'long-light') {
            const c = this.hair === 'long-dark' ? dark : light;
            svgEl('path', { d: 'M -30,-40 Q -32,-72 0,-74 Q 32,-72 30,-40 Q 22,-58 0,-58 Q -22,-58 -30,-40 Z', fill: c }, g);
            svgEl('path', { d: 'M -28,-40 Q -34,-10 -26,10 L -18,8 Q -24,-15 -20,-42 Z', fill: c }, g);
            svgEl('path', { d: 'M 28,-40 Q 34,-10 26,10 L 18,8 Q 24,-15 20,-42 Z', fill: c }, g);
        }
        // 'bald' ou autre → pas de cheveux dessinés
    }

    speak(text, duration) {
        if (STATE.skipScene) return;
        this.isSpeaking = true;
        const mouth = this.group.querySelector(`#mouth-${this.name}`);
        if (mouth) mouth.classList.add('mouth-animate');
        if (STATE.soundEnabled) this.speakFrench(text);
        setTimeout(() => this.stopSpeaking(), duration);
    }

    speakFrench(text) {
        try {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'fr-FR';
            const cfg = VOICES_CONFIG[this.name] || { gender: 'male', pitch: 1.0, rate: 0.98 };
            utterance.pitch = cfg.pitch;
            utterance.rate = cfg.rate;
            const voice = pickFrenchVoice(cfg.gender);
            if (voice) utterance.voice = voice;
            window.speechSynthesis.speak(utterance);
        } catch (e) { /* synthèse vocale indisponible — l'histoire continue avec les sous-titres */ }
    }

    stopSpeaking() {
        this.isSpeaking = false;
        const mouth = this.group.querySelector(`#mouth-${this.name}`);
        if (mouth) { mouth.classList.remove('mouth-animate'); mouth.setAttribute('ry', '4'); }
    }

    blink() {
        const pupils = this.group.querySelectorAll('[id^="pupil-"]');
        pupils.forEach(p => p.classList.add('eye-animate'));
        setTimeout(() => pupils.forEach(p => p.classList.remove('eye-animate')), 400);
    }

    wave(duration) {
        const arm = this.group.querySelector(`#arm-1-${this.name}`);
        if (!arm) return;
        arm.classList.add('arm-wave');
        setTimeout(() => arm.classList.remove('arm-wave'), duration || 1200);
    }

    walk(toX, toY, duration) {
        duration = duration || 2000;
        return new Promise(resolve => {
            const startX = this.x, startY = this.y;
            const startTime = performance.now();
            this.facing = toX >= startX ? 1 : -1;
            this.applyBodyTransform();

            const legL = this.group.querySelector(`#leg--1-${this.name}`);
            const legR = this.group.querySelector(`#leg-1-${this.name}`);
            const armL = this.group.querySelector(`#arm--1-${this.name}`);
            const armR = this.group.querySelector(`#arm-1-${this.name}`);
            if (legL) legL.classList.add('leg-animate-left');
            if (legR) legR.classList.add('leg-animate-right');
            if (armL) armL.classList.add('arm-animate-left');
            if (armR) armR.classList.add('arm-animate-right');

            const finish = () => {
                if (legL) legL.classList.remove('leg-animate-left');
                if (legR) legR.classList.remove('leg-animate-right');
                if (armL) armL.classList.remove('arm-animate-left');
                if (armR) armR.classList.remove('arm-animate-right');
                resolve();
            };

            const step = (now) => {
                if (STATE.skipScene) { this.setPosition(toX, toY); finish(); return; }
                const t = Math.min(1, (now - startTime) / duration);
                this.setPosition(startX + (toX - startX) * t, startY + (toY - startY) * t);
                if (t < 1) requestAnimationFrame(step);
                else finish();
            };
            requestAnimationFrame(step);
        });
    }

    async pickUpPose() {
        if (STATE.skipScene) return;
        this.applyBodyTransform('translate(0,10) scale(1,0.9)');
        await delay(260);
        this.applyBodyTransform();
        await delay(120);
    }

    setPosition(x, y) {
        this.x = x; this.y = y;
        this.group.setAttribute('transform', `translate(${x}, ${y})`);
    }

    hide() { this.group.style.opacity = '0'; this.group.style.pointerEvents = 'none'; }
    show() { this.group.style.opacity = '1'; this.group.style.pointerEvents = 'auto'; }
}

// ============================================
// 3. SPEECH BUBBLE + HELPER say()
// ============================================

function computeSpeechDuration(text) {
    return Math.max(2200, Math.min(6000, text.length * 65));
}

class SpeechBubble {
    constructor(character, text) {
        this.character = character;
        this.text = text;
        this.duration = computeSpeechDuration(text);
        this.bubble = this.createBubble();
    }

    createBubble() {
        const g = svgEl('g', { class: 'speech-bubble-group bubble-show' });
        const bubbleWidth = Math.min(360, Math.max(220, this.text.length * 7));
        const bubbleHeight = 92;
        const bubbleX = this.character.x - bubbleWidth / 2;
        const bubbleY = this.character.y - 172;

        svgEl('rect', { x: bubbleX, y: bubbleY, width: bubbleWidth, height: bubbleHeight, rx: 14, ry: 14, class: 'speech-bubble' }, g);
        svgEl('polygon', {
            points: `${this.character.x},${bubbleY + bubbleHeight} ${bubbleX + bubbleWidth * 0.35},${bubbleY + bubbleHeight} ${bubbleX + bubbleWidth * 0.45},${bubbleY + bubbleHeight + 18}`,
            class: 'speech-bubble-pointer'
        }, g);

        const textEl = svgEl('text', {
            x: bubbleX + bubbleWidth / 2, y: bubbleY + bubbleHeight / 2,
            class: 'speech-bubble-text', 'text-anchor': 'middle', 'dominant-baseline': 'middle'
        }, g);

        const maxCharsPerLine = Math.max(10, Math.floor(bubbleWidth / 9));
        const words = this.text.split(' ');
        const lines = [];
        let currentLine = '';
        words.forEach(word => {
            if ((currentLine + ' ' + word).trim().length > maxCharsPerLine) {
                lines.push(currentLine.trim());
                currentLine = word;
            } else {
                currentLine += ' ' + word;
            }
        });
        if (currentLine) lines.push(currentLine.trim());

        const offset = (lines.length - 1) * 0.65;
        lines.forEach((line, idx) => {
            svgEl('tspan', { x: bubbleX + bubbleWidth / 2, dy: idx === 0 ? `-${offset}em` : '1.3em', text: line }, textEl);
        });

        return g;
    }

    show() {
        if (STATE.skipScene) return;
        LAYERS.bubble().appendChild(this.bubble);
        this.character.speak(this.text, this.duration);
    }

    hide() {
        this.character.stopSpeaking();
        if (this.bubble.parentNode) this.bubble.parentNode.removeChild(this.bubble);
    }
}

async function say(character, text) {
    const bubble = new SpeechBubble(character, text);
    character.blink();
    bubble.show();
    await delay(bubble.duration);
    bubble.hide();
    await delay(450);
}

// ============================================
// 4. DÉCORS — Fonds de scène détaillés
// ============================================

function skyBackground(topColor, bottomColor, opts) {
    opts = opts || {};
    const g = svgEl('g', { class: 'bg-sky' });
    const gradId = `sky-${Math.random().toString(36).slice(2)}`;
    const defs = svgEl('defs', {}, g);
    const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    svgEl('stop', { offset: '0%', 'stop-color': topColor }, grad);
    svgEl('stop', { offset: '100%', 'stop-color': bottomColor }, grad);
    svgEl('rect', { width: 1920, height: 1080, fill: `url(#${gradId})` }, g);

    if (opts.sun) {
        svgEl('circle', { cx: opts.sunX || 1650, cy: opts.sunY || 180, r: 70, fill: '#FFE9A8', opacity: 0.9 }, g);
        svgEl('circle', { cx: opts.sunX || 1650, cy: opts.sunY || 180, r: 110, fill: '#FFE9A8', opacity: 0.3 }, g);
    }
    const cloudCount = opts.clouds || 0;
    for (let i = 0; i < cloudCount; i++) {
        buildCloud(g, rand(100, 1700), rand(80, 260), rand(0.7, 1.3));
    }
    return g;
}

function buildCloud(parent, x, y, scale) {
    const c = svgEl('g', { transform: `translate(${x},${y}) scale(${scale || 1})`, opacity: 0.85 }, parent);
    svgEl('ellipse', { cx: 0, cy: 0, rx: 55, ry: 28, fill: '#FFFFFF' }, c);
    svgEl('ellipse', { cx: 45, cy: 8, rx: 40, ry: 22, fill: '#FFFFFF' }, c);
    svgEl('ellipse', { cx: -45, cy: 8, rx: 40, ry: 22, fill: '#FFFFFF' }, c);
    return c;
}

function buildTree(parent, x, y, scale) {
    const t = svgEl('g', { transform: `translate(${x},${y}) scale(${scale || 1})` }, parent);
    svgEl('rect', { x: -10, y: 0, width: 20, height: 90, fill: '#6B4423' }, t);
    svgEl('circle', { cx: 0, cy: -30, r: 55, fill: '#4F8F3B' }, t);
    svgEl('circle', { cx: -35, cy: 0, r: 40, fill: '#5DA84A' }, t);
    svgEl('circle', { cx: 35, cy: 0, r: 40, fill: '#5DA84A' }, t);
    return t;
}

function buildLamppost(parent, x, y) {
    const l = svgEl('g', { transform: `translate(${x},${y})` }, parent);
    svgEl('rect', { x: -4, y: -160, width: 8, height: 160, fill: '#3a3a3a' }, l);
    svgEl('circle', { cx: 0, cy: -170, r: 16, fill: '#FFF3B0', opacity: 0.9 }, l);
    svgEl('circle', { cx: 0, cy: -170, r: 28, fill: '#FFF3B0', opacity: 0.25 }, l);
    return l;
}

function buildBench(parent, x, y) {
    const b = svgEl('g', { transform: `translate(${x},${y})` }, parent);
    svgEl('rect', { x: -50, y: 0, width: 100, height: 10, fill: '#8B5E34' }, b);
    svgEl('rect', { x: -50, y: -28, width: 100, height: 10, fill: '#8B5E34' }, b);
    [-45, 45].forEach(dx => svgEl('rect', { x: dx - 4, y: 0, width: 8, height: 24, fill: '#5a3d20' }, b));
    return b;
}

function buildSkylineSilhouette(parent, x, y) {
    const heights = [60, 100, 70, 130, 90];
    heights.forEach((h, i) => {
        svgEl('rect', { x: x + i * 60, y: y - h, width: 46, height: h, fill: '#7E9DBB' }, parent);
    });
}

const LITTER_TYPES = {
    bottle: { color: '#FFD23F', bin: 'plastique' },
    can: { color: '#C0C0C0', bin: 'verre-metal' },
    paper: { color: '#F4F1E8', bin: 'papier' },
    bag: { color: '#9AD0E0', bin: 'plastique' },
    cup: { color: '#E8A33D', bin: 'plastique' }
};

function buildLitterItem(type, x, y) {
    const info = LITTER_TYPES[type] || LITTER_TYPES.bottle;
    const g = svgEl('g', { transform: `translate(${x},${y})`, class: 'litter-item' });
    if (type === 'bottle') {
        svgEl('rect', { x: -6, y: -22, width: 12, height: 28, rx: 3, fill: info.color, stroke: '#333', 'stroke-width': 1.5 }, g);
        svgEl('rect', { x: -3, y: -28, width: 6, height: 8, fill: info.color, stroke: '#333', 'stroke-width': 1 }, g);
    } else if (type === 'can') {
        svgEl('rect', { x: -8, y: -18, width: 16, height: 22, rx: 2, fill: info.color, stroke: '#333', 'stroke-width': 1.5, transform: 'rotate(18)' }, g);
    } else if (type === 'paper') {
        svgEl('path', { d: 'M -12,-2 L 6,-14 L 12,2 L -6,12 Z', fill: info.color, stroke: '#999', 'stroke-width': 1 }, g);
    } else if (type === 'bag') {
        svgEl('path', { d: 'M -14,-10 Q 0,-26 14,-10 Q 18,4 8,14 Q -4,18 -14,4 Z', fill: info.color, opacity: 0.85, stroke: '#5fa', 'stroke-width': 1 }, g);
    } else if (type === 'cup') {
        svgEl('path', { d: 'M -8,-18 L 8,-18 L 6,8 L -6,8 Z', fill: info.color, stroke: '#333', 'stroke-width': 1.5 }, g);
    }
    g.dataset.binType = info.bin;
    return g;
}

const BIN_TYPES = {
    'plastique': { color: '#E8A33D', label: 'PLASTIQUE' },
    'papier': { color: '#3D6EDB', label: 'PAPIER' },
    'verre-metal': { color: '#3FA34D', label: 'VERRE / MÉTAL' }
};

function buildBin(parent, x, y, binType) {
    const info = BIN_TYPES[binType];
    const g = svgEl('g', { transform: `translate(${x},${y})` }, parent);
    svgEl('rect', { x: -55, y: 0, width: 110, height: 150, rx: 8, fill: info.color, stroke: '#2b2b2b', 'stroke-width': 3 }, g);
    svgEl('rect', { x: -60, y: -22, width: 120, height: 28, rx: 6, fill: '#2b2b2b' }, g);
    svgEl('circle', { cx: 0, cy: 30, r: 16, fill: 'rgba(255,255,255,0.18)' }, g);
    svgEl('text', { x: 0, y: 75, 'text-anchor': 'middle', fill: '#fff', 'font-size': 15, 'font-weight': 700, class: 'bin-label', text: info.label }, g);
    g.dataset.binType = binType;
    g.binCenter = { x, y: y + 10 };
    return g;
}

function bgDormRoom() {
    const g = svgEl('g', {});
    svgEl('rect', { width: 1920, height: 1080, fill: '#F6E6CE' }, g);
    svgEl('rect', { x: 0, y: 850, width: 1920, height: 230, fill: '#D8C49A' }, g);

    svgEl('rect', { x: 1550, y: 120, width: 300, height: 320, fill: '#FFB385', stroke: '#5a3d20', 'stroke-width': 8 }, g);
    svgEl('circle', { cx: 1700, cy: 280, r: 45, fill: '#FFE9A8' }, g);
    svgEl('line', { x1: 1700, y1: 120, x2: 1700, y2: 440, stroke: '#5a3d20', 'stroke-width': 6 }, g);
    svgEl('line', { x1: 1550, y1: 280, x2: 1850, y2: 280, stroke: '#5a3d20', 'stroke-width': 6 }, g);

    svgEl('rect', { x: 1100, y: 150, width: 220, height: 280, fill: '#3D6EDB', stroke: '#222', 'stroke-width': 4 }, g);
    svgEl('text', { x: 1210, y: 290, 'text-anchor': 'middle', fill: '#fff', 'font-size': 26, 'font-weight': 700, text: 'IUT' }, g);
    svgEl('text', { x: 1210, y: 320, 'text-anchor': 'middle', fill: '#fff', 'font-size': 14, text: 'BANDJOUN' }, g);

    svgEl('rect', { x: 750, y: 640, width: 380, height: 190, fill: '#6B4423', stroke: '#333', 'stroke-width': 2 }, g);
    svgEl('rect', { x: 820, y: 480, width: 220, height: 150, rx: 4, fill: '#222' }, g);
    svgEl('rect', { x: 836, y: 498, width: 188, height: 110, fill: '#3D6EDB' }, g);

    svgEl('rect', { x: 80, y: 720, width: 480, height: 260, rx: 10, fill: '#8B5E34', stroke: '#333', 'stroke-width': 2 }, g);
    svgEl('path', { d: 'M 100,760 Q 250,720 320,770 Q 420,800 540,750 L 540,960 L 100,960 Z', fill: '#E0584F' }, g);
    svgEl('ellipse', { cx: 150, cy: 740, rx: 55, ry: 28, fill: '#FAF6EE', stroke: '#ddd', 'stroke-width': 2 }, g);

    const clockOuter = svgEl('g', { transform: 'translate(680,610)' }, g);
    const clockFace = svgEl('g', { id: 'alarm-face' }, clockOuter);
    svgEl('circle', { cx: 0, cy: 0, r: 32, fill: '#E63946', stroke: '#222', 'stroke-width': 3 }, clockFace);
    svgEl('circle', { cx: 0, cy: 0, r: 26, fill: '#fff' }, clockFace);
    svgEl('line', { x1: 0, y1: 0, x2: 0, y2: -16, stroke: '#222', 'stroke-width': 2 }, clockFace);
    svgEl('line', { x1: 0, y1: 0, x2: 12, y2: 6, stroke: '#222', 'stroke-width': 2 }, clockFace);
    svgEl('circle', { cx: -28, cy: -28, r: 8, fill: '#E63946' }, clockFace);
    svgEl('circle', { cx: 28, cy: -28, r: 8, fill: '#E63946' }, clockFace);

    [[200, 950, '#7E57C2'], [340, 970, '#3FA34D'], [420, 940, '#E8A33D']].forEach(([x, y, c]) => {
        svgEl('path', { d: `M ${x - 30},${y} Q ${x},${y - 25} ${x + 30},${y} Q ${x + 20},${y + 18} ${x - 20},${y + 18} Z`, fill: c, opacity: 0.9 }, g);
    });

    svgEl('rect', { x: 1380, y: 760, width: 90, height: 120, rx: 14, fill: '#3FA34D', stroke: '#222', 'stroke-width': 2 }, g);

    return g;
}

function bgCampusCourtyard(opts) {
    opts = opts || {};
    const g = svgEl('g', {});
    g.appendChild(skyBackground('#8EC9E8', '#D7ECF5', { sun: true, sunX: 1700, sunY: 150, clouds: 3 }));
    svgEl('rect', { x: 0, y: 620, width: 1920, height: 460, fill: '#6FAE5C' }, g);
    svgEl('rect', { x: 0, y: 600, width: 1920, height: 40, fill: '#5A9148' }, g);
    svgEl('path', { d: 'M 0,760 Q 960,700 1920,760 L 1920,1080 L 0,1080 Z', fill: '#D8CBB0' }, g);

    buildTree(g, 140, 560, 1.1);
    buildTree(g, 1780, 540, 0.95);
    buildLamppost(g, 950, 560);
    buildBench(g, 1500, 780);

    if (opts.banner) {
        const banner = svgEl('g', { transform: 'translate(960,90)' }, g);
        svgEl('rect', { x: -280, y: -36, width: 560, height: 72, rx: 10, fill: '#E8A33D', stroke: '#2b2b2b', 'stroke-width': 3 }, banner);
        svgEl('text', { x: 0, y: 8, 'text-anchor': 'middle', 'font-size': 26, 'font-weight': 800, fill: '#fff', text: opts.banner }, banner);
    }

    if (opts.flowers) {
        for (let i = 0; i < 10; i++) {
            const fx = rand(80, 1840), fy = rand(800, 1040);
            const f = svgEl('g', { transform: `translate(${fx},${fy})` }, g);
            const color = pick(['#FF6B9D', '#FFD23F', '#E8A33D', '#FFFFFF']);
            for (let p = 0; p < 5; p++) {
                const angle = (Math.PI * 2 * p) / 5;
                svgEl('ellipse', { cx: Math.cos(angle) * 7, cy: Math.sin(angle) * 7, rx: 6, ry: 4, fill: color }, f);
            }
            svgEl('circle', { cx: 0, cy: 0, r: 4, fill: '#FFD23F' }, f);
        }
    }

    const litterItems = [];
    if (opts.litter) {
        const types = ['bottle', 'can', 'paper', 'bag', 'cup', 'bottle', 'paper'];
        const positions = [[260, 860], [420, 920], [600, 840], [780, 960], [1020, 880], [1240, 940], [1450, 860]];
        types.forEach((type, i) => {
            const [x, y] = positions[i];
            const item = buildLitterItem(type, x, y);
            item.dataset.x = x;
            item.dataset.y = y;
            g.appendChild(item);
            litterItems.push(item);
        });
    }

    return { group: g, litterItems };
}

function bgRecyclingCorner() {
    const g = svgEl('g', {});
    g.appendChild(skyBackground('#8EC9E8', '#D7ECF5', { sun: true, sunX: 1700, sunY: 150, clouds: 2 }));
    svgEl('rect', { x: 0, y: 620, width: 1920, height: 460, fill: '#6FAE5C' }, g);
    svgEl('path', { d: 'M 0,760 Q 960,700 1920,760 L 1920,1080 L 0,1080 Z', fill: '#D8CBB0' }, g);
    buildTree(g, 1800, 560, 1);

    const poleX = 960;
    svgEl('rect', { x: poleX - 5, y: 560, width: 10, height: 140, fill: '#3a3a3a' }, g);
    const sign = svgEl('g', { transform: `translate(${poleX},555)` }, g);
    svgEl('rect', { x: -130, y: -34, width: 260, height: 60, rx: 8, fill: '#3FA34D', stroke: '#2b2b2b', 'stroke-width': 3 }, sign);
    svgEl('text', { x: 0, y: 5, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 800, fill: '#fff', text: 'TRI SÉLECTIF' }, sign);

    const bins = {};
    bins['plastique'] = buildBin(g, 760, 760, 'plastique');
    bins['papier'] = buildBin(g, 960, 760, 'papier');
    bins['verre-metal'] = buildBin(g, 1160, 760, 'verre-metal');

    return { group: g, bins };
}

function bgClassroomDetailed() {
    const g = svgEl('g', {});
    svgEl('rect', { width: 1920, height: 1080, fill: '#F3E9DA' }, g);
    svgEl('rect', { x: 0, y: 850, width: 1920, height: 230, fill: '#C9B98C' }, g);
    svgEl('rect', { x: 1250, y: 120, width: 560, height: 360, fill: '#fff', stroke: '#333', 'stroke-width': 4 }, g);
    svgEl('text', { x: 1530, y: 200, 'text-anchor': 'middle', 'font-size': 22, fill: '#3D6EDB', text: 'Tri rapide — O(n log n)' }, g);
    svgEl('path', { d: 'M 1290,260 L 1430,260 L 1360,320 Z', fill: 'none', stroke: '#3D6EDB', 'stroke-width': 3 }, g);
    svgEl('path', { d: 'M 1470,240 L 1560,360', stroke: '#E8A33D', 'stroke-width': 3, fill: 'none' }, g);
    svgEl('circle', { cx: 1700, cy: 200, r: 28, fill: '#fff', stroke: '#333', 'stroke-width': 3 }, g);
    svgEl('line', { x1: 1700, y1: 200, x2: 1700, y2: 184, stroke: '#333', 'stroke-width': 2 }, g);
    svgEl('line', { x1: 1700, y1: 200, x2: 1712, y2: 200, stroke: '#333', 'stroke-width': 2 }, g);

    for (let i = 0; i < 6; i++) {
        svgEl('rect', { x: 90 + i * 290, y: 760, width: 220, height: 130, fill: '#8B5E34', stroke: '#333', 'stroke-width': 2 }, g);
        svgEl('rect', { x: 130 + i * 290, y: 870, width: 140, height: 14, fill: '#5a3d20' }, g);
    }

    svgEl('rect', { x: 60, y: 280, width: 14, height: 360, fill: '#5a3d20' }, g);
    svgEl('circle', { cx: 67, cy: 250, r: 40, fill: '#4F8F3B' }, g);

    return g;
}

function bgLibrary() {
    const g = svgEl('g', {});
    svgEl('rect', { width: 1920, height: 1080, fill: '#EFE3CC' }, g);
    svgEl('rect', { x: 0, y: 850, width: 1920, height: 230, fill: '#B89B6B' }, g);

    for (let row = 0; row < 2; row++) {
        const shelfY = 140 + row * 220;
        svgEl('rect', { x: 100, y: shelfY, width: 1720, height: 180, fill: '#6B4423' }, g);
        for (let i = 0; i < 26; i++) {
            const bx = 110 + i * 65;
            const bh = rand(120, 160);
            svgEl('rect', { x: bx, y: shelfY + 180 - bh, width: 50, height: bh, fill: pick(['#3D6EDB', '#E8A33D', '#3FA34D', '#7E57C2', '#E0584F']) }, g);
        }
    }

    svgEl('rect', { x: 760, y: 760, width: 400, height: 160, fill: '#8B5E34', stroke: '#333', 'stroke-width': 2 }, g);
    svgEl('circle', { cx: 760, cy: 700, r: 22, fill: '#FFE9A8' }, g);
    svgEl('rect', { x: 745, y: 700, width: 30, height: 60, fill: '#5a3d20' }, g);

    return g;
}

function bgOfficeInterview() {
    const g = svgEl('g', {});
    svgEl('rect', { width: 1920, height: 1080, fill: '#E7ECF2' }, g);
    svgEl('rect', { x: 0, y: 860, width: 1920, height: 220, fill: '#C7CFDA' }, g);

    svgEl('rect', { x: 1500, y: 140, width: 320, height: 420, fill: '#9FBFD8' }, g);
    buildSkylineSilhouette(g, 1500, 380);

    [[200, 180], [420, 180], [640, 180]].forEach(([x, y]) => {
        svgEl('rect', { x, y, width: 160, height: 110, fill: '#fff', stroke: '#9c8550', 'stroke-width': 10 }, g);
        svgEl('rect', { x: x + 14, y: y + 14, width: 132, height: 82, fill: '#F3E9DA' }, g);
    });

    svgEl('rect', { x: 760, y: 700, width: 420, height: 40, fill: '#5a3d20' }, g);
    svgEl('rect', { x: 780, y: 740, width: 14, height: 220, fill: '#3a2614' }, g);
    svgEl('rect', { x: 1146, y: 740, width: 14, height: 220, fill: '#3a2614' }, g);

    const wifi = svgEl('g', { transform: 'translate(1080,640)', id: 'wifi-icon' }, g);
    svgEl('rect', { x: -20, y: -10, width: 40, height: 20, rx: 4, fill: '#2b2b2b' }, wifi);
    svgEl('circle', { cx: -10, cy: 4, r: 3, fill: '#3FA34D' }, wifi);
    svgEl('circle', { cx: 0, cy: 4, r: 3, fill: '#3FA34D' }, wifi);
    svgEl('circle', { cx: 10, cy: 4, r: 3, fill: '#3FA34D' }, wifi);

    svgEl('path', { d: 'M 1690,770 Q 1700,740 1710,770 Z', fill: '#3FA34D' }, g);
    svgEl('rect', { x: 1685, y: 770, width: 30, height: 50, fill: '#8B5E34' }, g);

    return g;
}

function bgStudio() {
    const g = svgEl('g', {});
    svgEl('rect', { width: 1920, height: 1080, fill: '#1c2333' }, g);
    svgEl('ellipse', { cx: 960, cy: 1080, rx: 900, ry: 260, fill: 'rgba(255,255,255,0.04)' }, g);
    svgEl('rect', { x: 0, y: 860, width: 1920, height: 220, fill: '#161b27' }, g);

    svgEl('rect', { x: 460, y: 120, width: 1000, height: 560, rx: 14, fill: '#0c1018', stroke: '#3a4358', 'stroke-width': 6 }, g);
    const screen = svgEl('g', { transform: 'translate(960,400)', id: 'diagram-screen' }, g);
    svgEl('text', { x: 0, y: -210, 'text-anchor': 'middle', 'font-size': 22, fill: '#7E9DBB', text: 'ARCHITECTURE DU PROJET' }, screen);

    [260, 1660].forEach(x => {
        svgEl('ellipse', { cx: x, cy: 900, rx: 40, ry: 14, fill: '#3a4358' }, g);
        svgEl('rect', { x: x - 10, y: 830, width: 20, height: 70, fill: '#3a4358' }, g);
        svgEl('ellipse', { cx: x, cy: 828, rx: 26, ry: 10, fill: '#4a5670' }, g);
    });

    return g;
}

function drawDiagramLayer(index, label, color) {
    const screen = document.getElementById('diagram-screen');
    if (!screen) return;
    const y = -150 + index * 70;
    const row = svgEl('g', { transform: `translate(0,${y})`, class: 'scene-fade-in' }, screen);
    svgEl('rect', { x: -340, y: -22, width: 680, height: 44, rx: 8, fill: color, opacity: 0.18 }, row);
    svgEl('rect', { x: -340, y: -22, width: 14, height: 44, fill: color }, row);
    svgEl('text', { x: -310, y: 6, 'font-size': 20, 'font-weight': 700, fill: '#fff', text: `${index + 1}. ${label}` }, row);
}

// ============================================
// 5. EFFETS VISUELS
// ============================================

function spawnSparkle(x, y, color) {
    const g = svgEl('g', { transform: `translate(${x},${y})` }, LAYERS.fx());
    for (let i = 0; i < 5; i++) {
        const angle = (Math.PI * 2 * i) / 5;
        svgEl('circle', { cx: Math.cos(angle) * 18, cy: Math.sin(angle) * 18, r: 4, fill: color || '#3FA34D', class: 'sparkle-fx' }, g);
    }
    setTimeout(() => { if (g.parentNode) g.parentNode.removeChild(g); }, 750);
}

function blinkElement(el, times, interval) {
    return new Promise(resolve => {
        if (!el) { resolve(); return; }
        if (STATE.skipScene) { el.style.opacity = '1'; resolve(); return; }
        let count = 0;
        const total = (times || 4) * 2;
        const id = setInterval(() => {
            el.style.opacity = el.style.opacity === '0' ? '1' : '0';
            count++;
            if (count >= total || STATE.skipScene) {
                clearInterval(id);
                el.style.opacity = '1';
                resolve();
            }
        }, interval || 200);
    });
}

function shakeElement(el, baseTransform, duration) {
    return new Promise(resolve => {
        if (!el) { resolve(); return; }
        if (STATE.skipScene) { el.setAttribute('transform', baseTransform || ''); resolve(); return; }
        let elapsed = 0;
        const step = 60;
        const total = duration || 600;
        const id = setInterval(() => {
            elapsed += step;
            const angle = (elapsed % 120 < 60) ? 8 : -8;
            el.setAttribute('transform', `${baseTransform || ''} rotate(${angle})`.trim());
            if (elapsed >= total || STATE.skipScene) {
                clearInterval(id);
                el.setAttribute('transform', baseTransform || '');
                resolve();
            }
        }, step);
    });
}

function flyItemToBin(item, fromX, fromY, toX, toY, duration) {
    duration = duration || 800;
    return new Promise(resolve => {
        const start = performance.now();
        const peakLift = 90;
        const step = (now) => {
            if (STATE.skipScene) {
                if (item.parentNode) item.parentNode.removeChild(item);
                resolve();
                return;
            }
            const t = Math.min(1, (now - start) / duration);
            const x = fromX + (toX - fromX) * t;
            const y = fromY + (toY - fromY) * t - Math.sin(Math.PI * t) * peakLift;
            const scale = 1 - 0.6 * t;
            item.setAttribute('transform', `translate(${x},${y}) scale(${scale})`);
            if (t > 0.7) item.style.opacity = String(1 - (t - 0.7) / 0.3);
            if (t < 1) requestAnimationFrame(step);
            else {
                if (item.parentNode) item.parentNode.removeChild(item);
                resolve();
            }
        };
        requestAnimationFrame(step);
    });
}

async function tossLitterToBin(item, bin) {
    if (!item || !item.parentNode || !bin) return;
    const fromX = parseFloat(item.dataset.x);
    const fromY = parseFloat(item.dataset.y);
    const to = bin.binCenter || { x: fromX, y: fromY };
    AudioEngine.playThunk();
    await flyItemToBin(item, fromX, fromY, to.x, to.y, 750);
    const info = BIN_TYPES[bin.dataset.binType];
    spawnSparkle(to.x, to.y - 60, info ? info.color : '#3FA34D');
    AudioEngine.playDing();
}

function showCreditsCard() { document.getElementById('credits-card').classList.add('visible'); }
function hideCreditsCard() { document.getElementById('credits-card').classList.remove('visible'); }

// ============================================
// 6. SCÈNES
// ============================================

async function scene0_Intro() {
    const start = Date.now();
    clearScene();
    AudioEngine.startAmbient('campus');
    setBackground(bgCampusCourtyard({ banner: 'IUT BANDJOUN — 2026' }).group);

    const presenter = new Character(960, 820, 'presenter', { skin: '#F4A460', shirt: '#3D6EDB', hair: 'short-dark' });
    presentCharacters(presenter);

    await delay(700);
    presenter.wave(1200);
    await say(presenter, "Bonjour à tous, et bienvenue dans « Un Jour à l'IUT » !");
    await say(presenter, "Je suis ravi de vous présenter notre projet de développement multimédia, entièrement codé en HTML5, SVG et JavaScript.");

    showCreditsCard();
    await say(presenter, "Ce projet a été conçu et développé par deux étudiants de l'IUT de Bandjoun : Foapa Gianny et Tiemdjo Ryan.");
    await delay(1800);
    hideCreditsCard();

    await say(presenter, "Avant de commencer, laissez-moi vous présenter rapidement les quatre histoires qui vous attendent.");
    await say(presenter, "D'abord, « Vie Étudiante » : une matinée chaotique où Kevin apprend que l'IA aide... mais ne comprend pas à sa place.");
    await say(presenter, "Ensuite, « Le Grand Nettoyage » : Aline transforme un campus pollué en exemple de tri sélectif.");
    await say(presenter, "Puis « IA et Études » : un entretien d'embauche qui révèle ce qui se passe quand l'intelligence artificielle tombe en panne.");
    await say(presenter, "Et enfin « Les Coulisses », pour découvrir comment cette animation a été construite, sans aucun framework.");
    await say(presenter, "Alors, par laquelle voulez-vous commencer ? Choisissez une scène ci-dessous : vous pourrez toutes les regarder, dans l'ordre que vous voulez !");

    await ensureMinDuration(start, 42000);
}

async function scene1_StudentLife() {
    const start = Date.now();
    clearScene();
    AudioEngine.startAmbient('dorm');
    setBackground(bgDormRoom());

    const kevin = new Character(330, 560, 'kevin', { skin: '#F4A460', shirt: '#3D6EDB', hair: 'short-dark' });
    presentCharacters(kevin);

    await delay(900);
    await shakeElement(document.getElementById('alarm-face'), '', 1300);
    AudioEngine.playAlarmBeep(5);
    await say(kevin, "Sept heures et demie ?! J'ai dormi sur mon clavier toute la nuit !");
    await say(kevin, "Mon exposé sur le tri rapide... je devais le préparer avec l'IA hier soir !");
    await say(kevin, "Pas le temps de réfléchir : j'attrape mon sac, et je file !");

    clearScene();
    AudioEngine.startAmbient('campus');
    setBackground(bgCampusCourtyard({}).group);

    kevin.setPosition(120, 760);
    presentCharacters(kevin);
    const brice = new Character(900, 770, 'brice', { skin: '#C68642', shirt: '#3FA34D', hair: 'short-dark' });
    presentCharacters(brice);

    await kevin.walk(780, 760, 1600);
    await say(brice, "Kevin ! Tu cours comme si le bâtiment était en feu !");
    await say(kevin, "Pire : exposé dans cinq minutes, et je n'ai même pas relu mes notes !");
    await say(brice, "Tu avais dit que ton IA avait tout préparé, non ?");
    await say(kevin, "Justement... je crois que j'ai un peu trop fait confiance à ChatGPT.");
    await Promise.all([kevin.walk(1700, 760, 1400), brice.walk(1700, 840, 1400)]);

    clearScene();
    AudioEngine.startAmbient('classroom');
    setBackground(bgClassroomDetailed());

    kevin.setPosition(420, 820);
    brice.setPosition(700, 840);
    const nadia = new Character(980, 820, 'nadia', { skin: '#FDBCB4', shirt: '#FF6B9D', hair: 'long-dark' });
    const tchoumi = new Character(1650, 760, 'tchoumi', { skin: '#C68642', shirt: '#FFFFFF', hair: 'bald', accessory: 'glasses' });
    presentCharacters(kevin, brice, nadia, tchoumi);

    await say(tchoumi, "Kevin, à vous. Présentez votre analyse de l'algorithme de tri rapide.");
    await say(kevin, "Euh... oui ! Le tri rapide utilise un pivot, et... il sépare le tableau.");
    await say(kevin, "En fait... je ne suis pas certain de pouvoir expliquer pourquoi on choisit ce pivot.");
    await say(tchoumi, "C'est bien ce que je redoutais. Une réponse copiée n'est pas une réponse comprise.");
    await say(nadia, "Tchoumi a raison. L'IA peut écrire le code, mais c'est à toi de savoir pourquoi il fonctionne.");
    await say(kevin, "Vous avez raison... Pourriez-vous m'aider à vraiment comprendre, après le cours ?");
    await say(nadia, "Bien sûr ! Retrouve-nous à la bibliothèque dans dix minutes.");

    clearScene();
    AudioEngine.startAmbient('library');
    setBackground(bgLibrary());

    kevin.setPosition(700, 820);
    nadia.setPosition(980, 800);
    brice.setPosition(1180, 820);
    presentCharacters(kevin, nadia, brice);

    await say(nadia, "Regarde : le pivot sépare le tableau en deux groupes, plus petits et plus grands.");
    await say(brice, "Et on répète l'opération sur chaque groupe, jusqu'à ce qu'il ne reste qu'un élément.");
    kevin.blink();
    await say(kevin, "Ah ! Je comprends enfin pourquoi la complexité moyenne est en n log n !");
    await say(nadia, "Voilà ! Maintenant tu peux expliquer ton travail... pas seulement le réciter.");
    await say(kevin, "Merci à vous deux. La prochaine fois, je demanderai à l'IA d'expliquer, pas de faire à ma place.");

    await ensureMinDuration(start, 70000);
}

async function scene2_Recycling() {
    const start = Date.now();
    clearScene();
    AudioEngine.startAmbient('campus');
    const courtyard = bgCampusCourtyard({ litter: true });
    setBackground(courtyard.group);

    const aline = new Character(260, 800, 'aline', { skin: '#FDBCB4', shirt: '#7E57C2', hair: 'long-dark' });
    presentCharacters(aline);

    await aline.walk(560, 860, 1500);
    await say(aline, "Encore ces bouteilles, ces canettes, ces sacs abandonnés... ça ne peut plus durer.");
    await aline.pickUpPose();
    AudioEngine.playThunk();
    await say(aline, "Si personne ne commence, rien ne changera. Alors je vais commencer, moi.");

    const junior = new Character(60, 900, 'junior', { skin: '#A9784B', shirt: '#E8A33D', hair: 'short-dark' });
    const carine = new Character(1860, 900, 'carine', { skin: '#FDBCB4', shirt: '#3D6EDB', hair: 'long-light' });
    presentCharacters(junior, carine);

    await Promise.all([
        junior.walk(420, 880, 1500),
        carine.walk(760, 880, 1500),
        aline.walk(600, 880, 800)
    ]);

    await say(aline, "Junior, Carine ! J'ai besoin de vous pour une vraie opération de tri sur le campus.");
    await say(junior, "Encore une de tes idées un peu folles, Aline ?");
    await say(aline, "Folle ? Regarde autour de toi. On ne va pas nettoyer un jour : on va apprendre à trier, pour de bon.");
    await say(carine, "Elle n'a pas tort... je suis partante. Par où commence-t-on ?");
    await say(aline, "On installe trois bacs : plastique, papier, verre et métal. Ensuite, on montre l'exemple.");

    clearScene();
    AudioEngine.startAmbient('campus');
    const corner = bgRecyclingCorner();
    setBackground(corner.group);

    aline.setPosition(560, 880);
    junior.setPosition(820, 880);
    carine.setPosition(1080, 880);
    presentCharacters(aline, junior, carine);

    const pileTypes = ['bottle', 'can', 'paper', 'bag', 'cup', 'can'];
    const pilePositions = [[420, 940], [1300, 940], [660, 960], [1460, 960], [940, 980], [1180, 920]];
    const pile = pileTypes.map((type, i) => {
        const [x, y] = pilePositions[i];
        const item = buildLitterItem(type, x, y);
        item.dataset.x = x;
        item.dataset.y = y;
        LAYERS.bg().appendChild(item);
        return item;
    });

    await say(aline, "Celle-ci, c'est une bouteille en plastique : elle va dans le bac jaune.");
    await tossLitterToBin(pile[0], corner.bins['plastique']);
    await say(junior, "Et cette canette, dans le bac verre et métal.");
    await tossLitterToBin(pile[1], corner.bins['verre-metal']);
    await say(carine, "Le papier journal... dans le bac bleu, évidemment.");
    await tossLitterToBin(pile[2], corner.bins['papier']);

    await say(aline, "Regardez ! On n'a même pas terminé, et déjà le sol est plus propre.");

    await Promise.all([
        tossLitterToBin(pile[3], corner.bins['plastique']),
        delay(250).then(() => tossLitterToBin(pile[4], corner.bins['plastique']))
    ]);
    await tossLitterToBin(pile[5], corner.bins['verre-metal']);

    const eleve1 = new Character(1850, 760, 'eleve1', { skin: '#F4A460', shirt: '#3FA34D', hair: 'short-brown' });
    const eleve2 = new Character(60, 760, 'eleve2', { skin: '#FDBCB4', shirt: '#E8A33D', hair: 'long-dark' });
    presentCharacters(eleve1, eleve2);

    await Promise.all([
        eleve1.walk(1300, 860, 1300),
        eleve2.walk(700, 860, 1300)
    ]);

    await say(eleve1, "On peut vous aider ? On a vu ce que vous faisiez, c'est une super idée !");
    await say(aline, "Avec plaisir ! Plus on est nombreux, plus vite le campus respire.");

    AudioEngine.startAmbient('recycling-cheerful');
    await delay(1800);

    clearScene();
    AudioEngine.startAmbient('recycling-cheerful');
    setBackground(bgCampusCourtyard({ flowers: true, banner: 'CAMPUS PROPRE' }).group);

    aline.setPosition(700, 840);
    junior.setPosition(960, 860);
    carine.setPosition(1200, 840);
    presentCharacters(aline, junior, carine);

    await say(carine, "C'est incroyable... le campus n'a jamais été aussi agréable.");
    await say(junior, "Et maintenant, tout le monde sait où jeter ses déchets.");
    await say(aline, "Une petite initiative peut suffire à entraîner toute une communauté.");
    await say(aline, "Et vous ? Qu'allez-vous faire, dès aujourd'hui, pour votre propre environnement ?");

    await ensureMinDuration(start, 85000);
}

async function scene3_AIStudies() {
    const start = Date.now();
    clearScene();
    AudioEngine.startAmbient('dorm');
    setBackground(bgDormRoom());

    const kevin = new Character(700, 700, 'kevin', { skin: '#F4A460', shirt: '#3D6EDB', hair: 'short-dark' });
    presentCharacters(kevin);

    await delay(800);
    await say(kevin, "Demain, c'est l'entretien chez TechBandjoun. Je révise une dernière fois les bases.");
    AudioEngine.playTyping(6);
    await delay(900);
    await say(kevin, "Je peux demander à l'IA d'expliquer un concept... mais pas de répondre à ma place demain.");

    clearScene();
    AudioEngine.startAmbient('office');
    setBackground(bgOfficeInterview());

    const recruteur = new Character(960, 760, 'recruteur', { skin: '#C68642', shirt: '#1d2230', hair: 'bald', accessory: 'tie' });
    kevin.setPosition(560, 820);
    const candidat2 = new Character(1360, 820, 'candidat2', { skin: '#F4A460', shirt: '#7E57C2', hair: 'short-brown' });
    presentCharacters(recruteur, kevin, candidat2);

    await say(recruteur, "Merci d'être venus. Première épreuve : quinze minutes pour résoudre un petit problème de code.");
    await say(candidat2, "Pas de souci, je laisse l'intelligence artificielle s'en occuper entièrement.");
    await say(kevin, "Moi, je vais réfléchir d'abord, et m'en servir seulement pour vérifier mon raisonnement.");
    recruteur.blink();
    await say(recruteur, "Intéressant. Quinze minutes, à vos claviers.");

    AudioEngine.playTyping(8);
    await delay(1600);

    AudioEngine.playAlertCrash();
    await blinkElement(document.getElementById('wifi-icon'), 4, 150);
    await say(recruteur, "Attention ! Le service d'intelligence artificielle de l'entreprise vient de tomber en panne !");
    await say(candidat2, "Quoi ? Non, non... je suis bloqué, je ne sais pas continuer sans elle !");
    await say(kevin, "Pas de problème : je continue à la main, j'ai déjà compris la logique.");

    AudioEngine.playTyping(10);
    await delay(1700);

    await say(kevin, "Voilà, ma fonction est terminée, et je peux vous expliquer chaque ligne.");
    await say(recruteur, "Exactement le genre de réflexe que nous recherchons. Bienvenue chez nous, Kevin !");
    await say(candidat2, "Félicitations... je crois que j'ai des choses à revoir, moi aussi.");
    await say(recruteur, "L'IA est un excellent outil. Mais ici, c'est votre compréhension qu'on a embauchée.");

    await ensureMinDuration(start, 75000);
}

async function scene4_BehindScenes() {
    const start = Date.now();
    clearScene();
    AudioEngine.startAmbient('studio');
    setBackground(bgStudio());

    const presenter = new Character(680, 800, 'presenter', { skin: '#F4A460', shirt: '#3D6EDB', hair: 'short-dark' });
    const professeur = new Character(1260, 800, 'professeur', { skin: '#FDBCB4', shirt: '#E0584F', hair: 'long-light', accessory: 'glasses' });
    presentCharacters(presenter, professeur);

    await say(presenter, "Voici les coulisses d'« Un Jour à l'IUT ». Tout ce que vous avez vu n'utilise aucune image ni vidéo.");
    await say(professeur, "Aucune image ? Alors comment sont dessinés les personnages et les décors ?");
    await say(presenter, "Tout est vectoriel : du SVG généré en direct, forme par forme, par JavaScript.");

    drawDiagramLayer(0, 'Décors (fond)', '#3D6EDB');
    await say(presenter, "Une première couche gère les décors : ciel, salles de classe, campus...");
    drawDiagramLayer(1, 'Personnages', '#3FA34D');
    await say(presenter, "Une deuxième anime les personnages : marche, clignement des yeux, parole.");
    drawDiagramLayer(2, 'Bulles de dialogue', '#E8A33D');
    await say(presenter, "Une troisième affiche les bulles, dont la taille s'ajuste à la longueur du texte.");
    drawDiagramLayer(3, 'Effets visuels', '#7E57C2');
    await say(presenter, "Et une quatrième gère les effets : étincelles, alertes, transitions.");

    await say(professeur, "Et les voix que l'on entend ?");
    await say(presenter, "Web Speech API, directement dans le navigateur : chaque personnage a sa propre tonalité.");
    await say(professeur, "Pas de musique enregistrée non plus, j'imagine ?");
    await say(presenter, "Exact ! Toutes les ambiances sont générées en direct avec l'API Web Audio.");
    await say(professeur, "Aucun framework, aucune image, aucun son préenregistré... voilà qui est remarquable.");

    showCreditsCard();
    await say(presenter, "Ce projet a été pensé et codé par Foapa Gianny et Tiemdjo Ryan, à l'IUT de Bandjoun.");
    await delay(1600);
    hideCreditsCard();

    await say(presenter, "Merci d'avoir suivi cette aventure. Retournez au sélecteur pour explorer les autres scènes !");

    await ensureMinDuration(start, 68000);
}

// ============================================
// 7. NAVIGATION — Sélecteur de scène, Passer, chargement
// ============================================

function showSelector() {
    document.getElementById('main-stage').classList.add('dimmed');
    document.getElementById('scene-selector').classList.add('active');
}

function hideSelector() {
    document.getElementById('scene-selector').classList.remove('active');
    document.getElementById('main-stage').classList.remove('dimmed');
}

async function loadScene(sceneId) {
    if (STATE.isAnimating) return;
    STATE.isAnimating = true;
    STATE.skipScene = false;
    STATE.currentScene = sceneId;
    hideSelector();

    try {
        switch (sceneId) {
            case 1: await scene1_StudentLife(); break;
            case 2: await scene2_Recycling(); break;
            case 3: await scene3_AIStudies(); break;
            case 4: await scene4_BehindScenes(); break;
        }
    } catch (err) {
        console.error('Erreur dans la scène', sceneId, err);
    }

    AudioEngine.stopAmbient();
    STATE.isAnimating = false;
    STATE.skipScene = false;
    showSelector();
}

async function startExperience() {
    STATE.isAnimating = true;
    STATE.skipScene = false;
    try {
        await scene0_Intro();
    } catch (err) {
        console.error('Erreur dans la scène d\'introduction', err);
    }
    AudioEngine.stopAmbient();
    STATE.isAnimating = false;
    STATE.skipScene = false;
    showSelector();
}

// ============================================
// 8. INITIALISATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    refreshVoiceCache();
    try { window.speechSynthesis.onvoiceschanged = refreshVoiceCache; } catch (e) {}

    const unlockAudio = () => {
        AudioEngine.ensureCtx();
        const hint = document.getElementById('audio-hint');
        if (hint) hint.classList.add('hidden');
    };
    ['click', 'keydown', 'touchstart'].forEach(evt => window.addEventListener(evt, unlockAudio, { once: true }));
    AudioEngine.ensureCtx();

    document.getElementById('skip-btn').addEventListener('click', requestSkip);

    document.getElementById('sound-toggle').addEventListener('click', () => {
        STATE.soundEnabled = !STATE.soundEnabled;
        const btn = document.getElementById('sound-toggle');
        btn.classList.toggle('muted', !STATE.soundEnabled);
        btn.textContent = STATE.soundEnabled ? '🔊' : '🔇';
        AudioEngine.setSfxEnabled(STATE.soundEnabled);
        if (!STATE.soundEnabled) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    });

    document.getElementById('music-toggle').addEventListener('click', () => {
        STATE.musicEnabled = !STATE.musicEnabled;
        const btn = document.getElementById('music-toggle');
        btn.classList.toggle('muted', !STATE.musicEnabled);
        btn.textContent = STATE.musicEnabled ? '🎵' : '🔇';
        AudioEngine.setAmbientEnabled(STATE.musicEnabled);
    });

    document.querySelectorAll('.scene-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = parseInt(card.dataset.scene, 10);
            loadScene(id);
        });
    });

    console.log('🚀 "Un Jour à l\'IUT" — initialisation terminée.');
    startExperience();
});
