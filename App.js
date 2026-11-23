import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text as RNText,
  TextInput as RNTextInput,
  TouchableOpacity,
  FlatList,
  Switch,
  Image,
  ImageBackground,
  StyleSheet,
  Alert,
  AppState,
  ScrollView,
  StatusBar,
  Platform,
  Animated,
  Easing,
  useWindowDimensions,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';
import {
  CormorantGaramond_700Bold,
  CormorantGaramond_500Medium_Italic,
} from '@expo-google-fonts/cormorant-garamond';
import {
  NunitoSans_400Regular,
  NunitoSans_600SemiBold,
  NunitoSans_700Bold,
} from '@expo-google-fonts/nunito-sans';
import { NotoSerifDevanagari_700Bold } from '@expo-google-fonts/noto-serif-devanagari';

// ---------- constants ----------

const KEY = 'reminders_v1';
const WP = 'wallpaper_'; // wallpaper image is stored separately per reminder
const MAX_CHAIN = 70; // 5 hours at 5 min = 61 notifications
const BEAD_MS = 1300; // time between beads on the alert screen (the buzz follows the same beat)
const NAAM_OPACITY = 0.5; // how see-through the naam is on the alert screen (0 = invisible, 1 = solid)

// font families from the design: Cormorant Garamond (serif), Nunito Sans (body),
// Noto Serif Devanagari (the नाम जप title and the name on the alert screen)
const F = {
  serif: 'CormorantGaramond_700Bold',
  serifItalic: 'CormorantGaramond_500Medium_Italic',
  sans: 'NunitoSans_400Regular',
  sansSemi: 'NunitoSans_600SemiBold',
  sansBold: 'NunitoSans_700Bold',
  deva: 'NotoSerifDevanagari_700Bold',
};

// every Text and TextInput gets the body font by default; styles can override it
function Text({ style, ...props }) {
  return <RNText {...props} style={[{ fontFamily: F.sans }, style]} />;
}
function TextInput({ style, ...props }) {
  return <RNTextInput {...props} style={[{ fontFamily: F.sansSemi }, style]} />;
}

const C = {
  ivory: '#FBF4E6',
  card: '#FFFDF7',
  border: '#EBD9B8',
  chipBorder: '#D9B98A',
  text: '#3B1E1A',
  muted: '#7A5A4D',
  eyebrow: '#7A3A0C',
  maroon: '#4A1623',
  saffron: '#E07B22',
  cream: '#FFF3DC',
  gold: '#E9C177',
  danger: '#9B2C2C',
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// ---------- small helpers ----------

// Splits a name into at most 3 lines, only ever between words, so a word is never
// broken in the middle. Short words share a line ("Shri Hit"), long ones get their own.
function splitNaam(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const w of words) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + w.length <= 10) lines[last] += ' ' + w;
    else lines.push(w);
  }
  while (lines.length > 3) {
    const extra = lines.pop();
    lines[lines.length - 1] += ' ' + extra;
  }
  return lines.length ? lines : [String(text)];
}

const pad = (n) => String(n).padStart(2, '0');
const wrap = (v, max) => (v + max) % max;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const formatTime = (d) => {
  const h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h >= 12 ? 'PM' : 'AM'}`;
};
const dayLabel = (d) => {
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
};
const longDay = (d) => `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const durText = (m) => (m < 60 ? `${m} min` : `${m / 60} ${m === 60 ? 'hour' : 'hours'}`);
const repeatText = (r) => (r.repeatMin > 0 ? `Every ${r.repeatMin} min · ${durText(r.durationMin)}` : 'Once');
const statusText = (r) => {
  const d = new Date(r.time);
  if (r.status === 'done') return 'Done';
  if (r.status === 'fired') return `Rang at ${formatTime(d)}`;
  return `${formatTime(d)} · ${dayLabel(d)}`;
};

// ---------- scheduling helpers ----------

async function cancelChain(r) {
  for (let n = 0; n < MAX_CHAIN; n++) {
    await Notifications.cancelScheduledNotificationAsync(`${r.id}-${n}`);
  }
}

// Schedules the first notification plus a chain of repeats.
// Returns how many notifications were actually scheduled.
async function scheduleChain(r) {
  await cancelChain(r);
  const first = new Date(r.time).getTime();
  const step = r.repeatMin * 60000;
  const count = r.repeatMin > 0 ? Math.floor(r.durationMin / r.repeatMin) + 1 : 1;
  const now = Date.now();
  let scheduled = 0;
  for (let n = 0; n < count; n++) {
    const when = first + n * step;
    if (when <= now) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: `${r.id}-${n}`,
      content: {
        title: r.title,
        body: n === 0 ? 'Time for your japa' : `Japa again (${n}) - tap to open and stop`,
        sound: true,
        data: { reminderId: r.id },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(when),
      },
    });
    scheduled++;
  }
  return scheduled;
}

// ---------- decorative pieces (plain views, no extra packages) ----------

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Vertical gradient made of thin coloured strips.
function Gradient({ colors, height, style, steps = 48 }) {
  const strips = [];
  const segs = colors.length - 1;
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * segs;
    const k = Math.min(Math.floor(t), segs - 1);
    const f = t - k;
    const a = hexToRgb(colors[k]);
    const b = hexToRgb(colors[k + 1]);
    const c = a.map((v, j) => Math.round(v + (b[j] - v) * f));
    strips.push(<View key={i} style={{ flex: 1, backgroundColor: `rgb(${c[0]},${c[1]},${c[2]})` }} />);
  }
  return (
    <View pointerEvents="none" style={[{ height }, style]}>
      {strips}
    </View>
  );
}

// ---------- lotus ----------
// The lotus is built from plain views (no extra package needed): five translucent,
// overlapping petals. Each petal is a pointed leaf made of three stacked layers, so
// the colour fades from pink at the tip to saffron at the base, and its gold outline
// shows through where petals overlap. A leaf is a square with two opposite corners
// fully rounded, turned 45 degrees, then squeezed to the right width.

const LOTUS_PETALS = [
  // a = final angle, len = length in design units, from/to = when it opens (0 to 1)
  { a: -62, len: 78, from: 0.0, to: 0.62 },
  { a: 62, len: 78, from: 0.0, to: 0.62 },
  { a: -32, len: 78, from: 0.18, to: 0.8 },
  { a: 32, len: 78, from: 0.18, to: 0.8 },
  { a: 0, len: 86, from: 0.34, to: 1.0 },
];
const LEAF_SQUEEZE = 0.63; // leaf width compared with its natural width

// one pointed leaf of height h, sitting on the bottom edge of a box that is `box` wide
function Leaf({ box, h, color, alpha, edge, edgeW }) {
  const d = h / Math.SQRT2;
  const [r, g, b] = hexToRgb(color);
  return (
    <View
      style={{
        position: 'absolute',
        bottom: 0,
        left: (box - h) / 2,
        width: h,
        height: h,
        transform: [{ scaleX: LEAF_SQUEEZE }],
      }}
    >
      <View
        style={{
          position: 'absolute',
          left: (h - d) / 2,
          top: (h - d) / 2,
          width: d,
          height: d,
          borderTopLeftRadius: d,
          borderBottomRightRadius: d,
          backgroundColor: `rgba(${r},${g},${b},${alpha})`,
          borderWidth: edge ? edgeW : 0,
          borderColor: edge || 'transparent',
          transform: [{ rotate: '-45deg' }],
        }}
      />
    </View>
  );
}

// The lotus. `fill` gives a single flat colour; without it the petals fade from pink
// to saffron. `bloom` (an Animated.Value from 0 to 1) opens it from a closed bud;
// without it the lotus is shown fully open. `line` adds the thin water line.
function Lotus({ width = 140, fill, edge = '#C99A3B', opacity = 0.8, line = false, bloom = null }) {
  const k = width / 200; // size of one design unit in points
  const edgeW = Math.max(0.8, 1.4 * k);
  const m = opacity / 0.8;

  // built once, so re-renders of the screen never disturb a running animation
  const motion = useMemo(() => {
    if (!bloom) {
      return { root: 1, petals: LOTUS_PETALS.map((p) => [{ rotate: `${p.a}deg` }]) };
    }
    const step = (p, out0, out1) =>
      bloom.interpolate({ inputRange: [p.from, p.to], outputRange: [out0, out1], extrapolate: 'clamp' });
    return {
      root: bloom.interpolate({ inputRange: [0, 0.12], outputRange: [0, 1], extrapolate: 'clamp' }),
      petals: LOTUS_PETALS.map((p) => [
        { rotate: step(p, `${p.a * 0.12}deg`, `${p.a}deg`) },
        { scaleX: step(p, 0.55, 1) },
        { scaleY: step(p, 0.78, 1) },
      ]),
    };
  }, [bloom]);

  // the water line: a gentle curve drawn as many short thin pieces
  const water = [];
  if (line) {
    const N = 60;
    const pt = (u) => {
      const q = 1 - u;
      return [
        q * q * q * 28 + 3 * q * q * u * 70 + 3 * q * u * u * 130 + u * u * u * 172,
        q * q * q * 108 + 3 * q * q * u * 114 + 3 * q * u * u * 114 + u * u * u * 108,
      ];
    };
    for (let i = 0; i < N; i++) {
      const p0 = pt(i / N);
      const p1 = pt((i + 1) / N);
      const dx = (p1[0] - p0[0]) * k;
      const dy = (p1[1] - p0[1]) * k;
      const L = Math.hypot(dx, dy) + 1;
      water.push(
        <View
          key={'w' + i}
          style={{
            position: 'absolute',
            left: ((p0[0] + p1[0]) / 2) * k - L / 2,
            top: ((p0[1] + p1[1]) / 2) * k - edgeW / 2,
            width: L,
            height: edgeW,
            backgroundColor: edge,
            transform: [{ rotate: `${(Math.atan2(dy, dx) * 180) / Math.PI}deg` }],
          }}
        />
      );
    }
  }

  return (
    <Animated.View pointerEvents="none" style={{ width, height: 120 * k, opacity: motion.root }}>
      {LOTUS_PETALS.map((p, i) => {
        const len = p.len * k;
        return (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              left: (100 - p.len / 2) * k,
              top: (102 - p.len) * k,
              width: len,
              height: len * 2,
              transform: motion.petals[i],
            }}
          >
            <View style={{ position: 'absolute', top: 0, left: 0, width: len, height: len }}>
              {fill ? (
                <Leaf box={len} h={len} color={fill} alpha={opacity} edge={edge} edgeW={edgeW} />
              ) : (
                <>
                  <Leaf box={len} h={len} color="#F29BB0" alpha={opacity} edge={edge} edgeW={edgeW} />
                  <Leaf box={len} h={len * 0.72} color="#EE8F6B" alpha={0.44 * m} />
                  <Leaf box={len} h={len * 0.44} color="#E07B22" alpha={0.48 * m} />
                </>
              )}
            </View>
          </Animated.View>
        );
      })}
      {water}
    </Animated.View>
  );
}

// The lotus on the home screen: opens from a bud when the screen appears.
function BloomLotus({ width = 190, delay = 250, duration = 2800 }) {
  const bloom = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(bloom, {
      toValue: 1,
      duration,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, []);
  return <Lotus width={width} line bloom={bloom} />;
}

// A mala ring of 108 beads. `step` is the bead being counted right now:
// beads before it are lit gold, beads after it stay dim, and the current bead
// glows larger. The parent advances `step` every BEAD_MS (1.3 seconds).
const BEADS = 108;

function MalaRing({ size = 300, step = 0 }) {
  const c = size / 2;
  const r = size * 0.4;
  const beads = [];
  for (let i = 0; i < BEADS; i++) {
    const phi = (i * 2 * Math.PI) / BEADS;
    const x = c + r * Math.sin(phi);
    const y = c - r * Math.cos(phi);
    const head = i === step;
    const counted = i < step;
    const rad = head ? size * 0.026 : size * 0.0085;
    beads.push(
      <View
        key={i}
        style={{
          position: 'absolute',
          left: x - rad,
          top: y - rad,
          width: rad * 2,
          height: rad * 2,
          borderRadius: rad,
          backgroundColor: head ? C.cream : counted ? C.gold : 'rgba(233,193,119,0.32)',
        }}
      />
    );
  }
  const hx = c + r * Math.sin((step * 2 * Math.PI) / BEADS);
  const hy = c - r * Math.cos((step * 2 * Math.PI) / BEADS);
  const glow = size * 0.06;
  const disc = (rad, color) => (
    <View
      style={{
        position: 'absolute',
        left: c - rad,
        top: c - rad,
        width: rad * 2,
        height: rad * 2,
        borderRadius: rad,
        backgroundColor: color,
      }}
    />
  );
  const ring = (rad, color) => (
    <View
      style={{
        position: 'absolute',
        left: c - rad,
        top: c - rad,
        width: rad * 2,
        height: rad * 2,
        borderRadius: rad,
        borderWidth: 1.5,
        borderColor: color,
      }}
    />
  );
  return (
    <View pointerEvents="none" style={{ width: size, height: size }}>
      {disc(size * 0.5, 'rgba(247,217,160,0.06)')}
      {disc(size * 0.4, 'rgba(247,217,160,0.08)')}
      {disc(size * 0.3, 'rgba(247,217,160,0.10)')}
      {ring(size * 0.33, 'rgba(247,217,160,0.22)')}
      {ring(size * 0.25, 'rgba(247,217,160,0.14)')}
      <View
        style={{
          position: 'absolute',
          left: hx - glow,
          top: hy - glow,
          width: glow * 2,
          height: glow * 2,
          borderRadius: glow,
          backgroundColor: 'rgba(255,243,220,0.22)',
        }}
      />
      {beads}
    </View>
  );
}

// ---------- form pieces ----------

function Chip({ label, active, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Stepper({ label, onMinus, onPlus }) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.row}>
        <TouchableOpacity style={styles.stepBtn} onPress={onMinus}>
          <Text style={styles.stepBtnText}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.stepBtn, { backgroundColor: '#FBE3C0' }]} onPress={onPlus}>
          <Text style={styles.stepBtnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ReminderForm({ initial, onSave, onCancel, onDelete }) {
  // when editing a reminder whose time is still in the future, start from its time;
  // otherwise start 5 minutes from now
  const start =
    initial && new Date(initial.time).getTime() > Date.now()
      ? new Date(initial.time)
      : new Date(Date.now() + 5 * 60000);
  const [title, setTitle] = useState(initial ? initial.title : '');
  const [displayName, setDisplayName] = useState(initial && initial.displayName ? initial.displayName : '');
  const [dayOffset, setDayOffset] = useState(
    Math.round((startOfDay(start) - startOfDay(new Date())) / 86400000)
  );
  const [hour12, setHour12] = useState(start.getHours() % 12 || 12);
  const [isPM, setIsPM] = useState(start.getHours() >= 12);
  const [minute, setMinute] = useState(start.getMinutes());
  const [repeatMin, setRepeatMin] = useState(initial ? initial.repeatMin : 0);
  const [durationMin, setDurationMin] = useState(initial ? initial.durationMin : 60);
  const [wallpaper, setWallpaper] = useState(null); // base64 data uri

  const buildDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours((hour12 % 12) + (isPM ? 12 : 0), minute, 0, 0);
    return d;
  };

  // when editing, load the wallpaper already saved for this reminder
  useEffect(() => {
    if (initial) {
      AsyncStorage.getItem(WP + initial.id).then((v) => {
        if (v) setWallpaper(v);
      });
    }
  }, []);

  const pickImage = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.4,
      base64: true,
    });
    if (!res.canceled && res.assets && res.assets[0].base64) {
      setWallpaper(`data:image/jpeg;base64,${res.assets[0].base64}`);
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete this japa?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
  };

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <Gradient
        colors={['#F6C07A', '#FBF4E6']}
        height={300}
        style={{ position: 'absolute', top: 0, left: 0, right: 0 }}
      />
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={onCancel} style={styles.cancelBtn}>
          <Text style={styles.cancelText}>‹ Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.formTitle}>{initial ? 'Edit japa' : 'New japa'}</Text>
        <Text style={styles.formSub}>Set the hour you wish to remember</Text>

        <Text style={styles.label}>NAME</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. Morning Ram japa"
          placeholderTextColor="#8A6F62"
        />

        <Text style={styles.label}>NAAM ON ALERT SCREEN (OPTIONAL)</Text>
        <TextInput
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="e.g. राम"
          placeholderTextColor="#8A6F62"
        />
        <Text style={[styles.hint, { textAlign: 'left', marginTop: 6 }]}>
          Shown large and see-through over the wallpaper. Leave empty to show the name above.
        </Text>

        <Text style={styles.label}>WHEN</Text>
        <View style={styles.whenCard}>
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text style={styles.bigTime}>
              {hour12}:{pad(minute)}
            </Text>
            <View>
              <TouchableOpacity
                style={[styles.ampm, isPM === false && styles.ampmActive]}
                onPress={() => setIsPM(false)}
              >
                <Text style={[styles.ampmText, isPM === false && { color: C.cream }]}>AM</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.ampm, isPM === true && styles.ampmActive, { marginTop: 8 }]}
                onPress={() => setIsPM(true)}
              >
                <Text style={[styles.ampmText, isPM === true && { color: C.cream }]}>PM</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.dateText}>{longDay(buildDate())}</Text>
          <View style={styles.stepGrid}>
            <Stepper
              label="Day"
              onMinus={() => setDayOffset((d) => Math.max(0, d - 1))}
              onPlus={() => setDayOffset((d) => Math.min(60, d + 1))}
            />
            <Stepper
              label="Hour"
              onMinus={() => setHour12((h) => (h === 1 ? 12 : h - 1))}
              onPlus={() => setHour12((h) => (h % 12) + 1)}
            />
            <Stepper
              label="Minute"
              onMinus={() => setMinute((m) => wrap(m - 1, 60))}
              onPlus={() => setMinute((m) => wrap(m + 1, 60))}
            />
            <Stepper
              label="5 minutes"
              onMinus={() => setMinute((m) => wrap(m - 5, 60))}
              onPlus={() => setMinute((m) => wrap(m + 5, 60))}
            />
          </View>
        </View>

        <Text style={styles.label}>REPEAT EVERY</Text>
        <View style={styles.chipRow}>
          <Chip label="Once" active={repeatMin === 0} onPress={() => setRepeatMin(0)} />
          <Chip label="5 min" active={repeatMin === 5} onPress={() => setRepeatMin(5)} />
          <Chip label="10 min" active={repeatMin === 10} onPress={() => setRepeatMin(10)} />
          <Chip label="15 min" active={repeatMin === 15} onPress={() => setRepeatMin(15)} />
        </View>

        {repeatMin > 0 && (
          <>
            <Text style={styles.label}>KEEP REPEATING FOR</Text>
            <View style={styles.chipRow}>
              <Chip label="30 min" active={durationMin === 30} onPress={() => setDurationMin(30)} />
              <Chip label="1 hour" active={durationMin === 60} onPress={() => setDurationMin(60)} />
              <Chip label="2 hours" active={durationMin === 120} onPress={() => setDurationMin(120)} />
              <Chip label="3 hours" active={durationMin === 180} onPress={() => setDurationMin(180)} />
              <Chip label="4 hours" active={durationMin === 240} onPress={() => setDurationMin(240)} />
              <Chip label="5 hours" active={durationMin === 300} onPress={() => setDurationMin(300)} />
            </View>
          </>
        )}

        <Text style={styles.label}>WALLPAPER</Text>
        <View style={styles.wallCard}>
          <View style={styles.thumb}>
            {wallpaper ? (
              <Image source={{ uri: wallpaper }} style={{ width: 92, height: 120 }} resizeMode="cover" />
            ) : (
              <>
                <Gradient
                  colors={['#1E0B2B', '#4A1B3A', '#9A3F2A', '#E07B22']}
                  style={StyleSheet.absoluteFill}
                  steps={24}
                />
                <View style={{ position: 'absolute', left: 14, bottom: 10 }}>
                  <Lotus width={64} fill="#F7D9A0" edge="#B07A2E" opacity={0.95} />
                </View>
              </>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.wallHint}>Appears full screen when this japa reminder opens.</Text>
            <View style={[styles.row, { marginTop: 10 }]}>
              <TouchableOpacity style={styles.outlineBtn} onPress={pickImage}>
                <Text style={styles.outlineBtnText}>{wallpaper ? 'Change image' : 'Choose image'}</Text>
              </TouchableOpacity>
              {wallpaper && (
                <TouchableOpacity style={{ marginLeft: 12, minHeight: 44, justifyContent: 'center' }} onPress={() => setWallpaper(null)}>
                  <Text style={{ color: C.danger, fontFamily: F.sansBold, fontSize: 15 }}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={styles.saveBtn}
          onPress={() => {
            if (!title.trim()) {
              Alert.alert('Add a name first');
              return;
            }
            onSave(
              {
                title: title.trim(),
                displayName: displayName.trim(),
                time: buildDate().toISOString(),
                repeatMin,
                durationMin,
              },
              wallpaper
            );
          }}
        >
          <Text style={styles.saveText}>Save japa</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>Opening the app stops the remaining repeats.</Text>

        {initial && (
          <TouchableOpacity onPress={confirmDelete} style={{ alignSelf: 'center', marginTop: 18, minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: C.danger, fontFamily: F.sansBold, fontSize: 15 }}>Delete this japa</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

// ---------- main app ----------

export default function App() {
  const [reminders, setReminders] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [alertId, setAlertId] = useState(null);
  const [alertImage, setAlertImage] = useState(null);
  const [beadStep, setBeadStep] = useState(0);
  const [bloomKey, setBloomKey] = useState(0);
  const remindersRef = useRef([]);
  const processed = useRef(null);
  const { width, height } = useWindowDimensions();
  const [fontsLoaded, fontError] = useFonts({
    CormorantGaramond_700Bold,
    CormorantGaramond_500Medium_Italic,
    NunitoSans_400Regular,
    NunitoSans_600SemiBold,
    NunitoSans_700Bold,
    NotoSerifDevanagari_700Bold,
  });

  const save = async (list) => {
    remindersRef.current = list;
    setReminders(list);
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  };

  // Stops the repeat chain for anything whose first time has passed.
  // Used when the app is opened: "app open = reminders stop".
  const sweepFired = async () => {
    const now = Date.now();
    let changed = false;
    const next = [];
    for (const r of remindersRef.current) {
      if (r.enabled && r.status === 'scheduled' && new Date(r.time).getTime() <= now) {
        await cancelChain(r);
        next.push({ ...r, status: 'fired' });
        changed = true;
      } else {
        next.push(r);
      }
    }
    if (changed) {
      await Notifications.dismissAllNotificationsAsync();
      await save(next);
    }
  };

  // load saved reminders + ask for notification permission
  useEffect(() => {
    (async () => {
      await Notifications.requestPermissionsAsync();
      const raw = await AsyncStorage.getItem(KEY);
      const list = raw ? JSON.parse(raw) : [];
      remindersRef.current = list;
      setReminders(list);
      setLoaded(true);
      await sweepFired();
    })();
  }, []);

  // sweep whenever the app comes back to the foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') sweepFired();
    });
    return () => sub.remove();
  }, []);

  // notification arrives while app is open -> show the alert screen
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((n) => {
      const id = n.request.content.data && n.request.content.data.reminderId;
      if (id) setAlertId(id);
    });
    return () => sub.remove();
  }, []);

  // user taps a notification (works from a cold start too)
  const lastResponse = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!lastResponse) return;
    const data = lastResponse.notification.request.content.data;
    if (data && data.reminderId) setAlertId(data.reminderId);
  }, [lastResponse]);

  // when the alert screen opens: stop the chain, load the wallpaper
  useEffect(() => {
    if (!loaded || !alertId || processed.current === alertId) return;
    const r = remindersRef.current.find((x) => x.id === alertId);
    if (!r) {
      setAlertId(null);
      return;
    }
    processed.current = alertId;
    (async () => {
      await cancelChain(r);
      await Notifications.dismissAllNotificationsAsync();
      await save(remindersRef.current.map((x) => (x.id === r.id ? { ...x, status: 'fired' } : x)));
      setAlertImage(await AsyncStorage.getItem(WP + r.id));
    })();
  }, [alertId, loaded]);

  // while the alert screen is showing, once every BEAD_MS (1.3 seconds): buzz, and move the
  // mala ring on by one bead (108 beads, then it starts a new round)
  useEffect(() => {
    if (!alertId) return;
    const buzz = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setBeadStep(0);
    buzz();
    const t = setInterval(() => {
      buzz();
      setBeadStep((n) => (n + 1) % BEADS);
    }, BEAD_MS);
    return () => clearInterval(t);
  }, [alertId]);

  const closeAlert = () => {
    processed.current = null;
    setAlertImage(null);
    setAlertId(null);
  };

  const onDone = async () => {
    await save(
      remindersRef.current.map((x) =>
        x.id === alertId ? { ...x, status: 'done', enabled: false } : x
      )
    );
    closeAlert();
  };

  const onSnooze = async () => {
    const r = remindersRef.current.find((x) => x.id === alertId);
    if (r) {
      const updated = {
        ...r,
        time: new Date(Date.now() + 5 * 60000).toISOString(),
        status: 'scheduled',
        enabled: true,
      };
      await scheduleChain(updated);
      await save(remindersRef.current.map((x) => (x.id === r.id ? updated : x)));
    }
    closeAlert();
  };

  // creates a new reminder, or updates the one being edited
  const saveReminder = async (fields, wallpaper) => {
    const existing = editingId ? remindersRef.current.find((x) => x.id === editingId) : null;
    const r = existing
      ? { ...existing, ...fields, enabled: true, status: 'scheduled' }
      : { id: String(Date.now()), ...fields, enabled: true, status: 'scheduled' };
    const n = await scheduleChain(r);
    if (n === 0) {
      Alert.alert('Pick a time in the future');
      if (existing && existing.enabled && existing.status === 'scheduled') {
        await scheduleChain(existing); // put the old schedule back
      }
      return;
    }
    if (wallpaper) await AsyncStorage.setItem(WP + r.id, wallpaper);
    else await AsyncStorage.removeItem(WP + r.id);
    await save(
      existing
        ? remindersRef.current.map((x) => (x.id === r.id ? r : x))
        : [...remindersRef.current, r]
    );
    setAdding(false);
    setEditingId(null);
  };

  const toggle = async (r, value) => {
    if (value) {
      const n = await scheduleChain({ ...r, status: 'scheduled' });
      if (n === 0) {
        Alert.alert('That time has passed', 'Tap the japa to choose a new time.');
        return;
      }
      await save(
        remindersRef.current.map((x) =>
          x.id === r.id ? { ...x, enabled: true, status: 'scheduled' } : x
        )
      );
    } else {
      await cancelChain(r);
      await save(remindersRef.current.map((x) => (x.id === r.id ? { ...x, enabled: false } : x)));
    }
  };

  const remove = async (r) => {
    await cancelChain(r);
    await AsyncStorage.removeItem(WP + r.id);
    await save(remindersRef.current.filter((x) => x.id !== r.id));
  };

  // ---------- screens ----------

  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: C.ivory }} />;
  }

  // 1) alert screen
  const alertReminder = reminders.find((x) => x.id === alertId);
  if (alertId && alertReminder) {
    const ring = Math.min(300, height * 0.34, width * 0.8);
    // the naam shown in the ring: the optional alert text, otherwise the reminder name
    const naam = alertReminder.displayName || alertReminder.title;
    const naamFont = /[\u0900-\u097F]/.test(naam) ? F.deva : F.serif;
    // size the naam to its longest line, so any name fits (it shrinks as the name grows)
    const naamLines = splitNaam(naam);
    const naamBox = ring * 0.66;
    const naamLongest = Math.max(...naamLines.map((l) => l.length));
    const naamBase = ring * (naamLines.length === 1 ? 0.34 : naamLines.length === 2 ? 0.27 : 0.21);
    const naamSize = Math.max(16, Math.min(naamBase, naamBox / (naamLongest * 0.52)));
    return (
      <View style={{ flex: 1, backgroundColor: '#1E0B2B' }}>
        <StatusBar barStyle="light-content" />
        {alertImage ? (
          <ImageBackground source={{ uri: alertImage }} style={StyleSheet.absoluteFill} resizeMode="cover">
            <View style={{ flex: 1, backgroundColor: 'rgba(20,8,30,0.28)' }} />
          </ImageBackground>
        ) : (
          <Gradient
            colors={['#1E0B2B', '#4A1B3A', '#9A3F2A', '#E07B22']}
            style={StyleSheet.absoluteFill}
            steps={64}
          />
        )}
        <View style={styles.alertWrap}>
          <Text style={styles.alertCaption}>TIME FOR YOUR JAPA</Text>

          <View style={{ alignItems: 'center' }}>
            <View style={{ width: ring, height: ring }}>
              <MalaRing size={ring} step={beadStep} />
              <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
                <Text
                  style={[
                    styles.alertName,
                    {
                      fontFamily: naamFont,
                      fontSize: naamSize,
                      width: naamBox,
                      color: `rgba(255,243,220,${NAAM_OPACITY})`,
                    },
                  ]}
                  numberOfLines={naamLines.length}
                  adjustsFontSizeToFit
                  minimumFontScale={0.2}
                >
                  {naamLines.join('\n')}
                </Text>
              </View>
            </View>
            {alertReminder.displayName ? (
              <Text style={styles.alertTitle}>{alertReminder.title}</Text>
            ) : null}
            <Text style={styles.alertSub}>
              {formatTime(new Date(alertReminder.time))} · the buzz continues until you tap Done
            </Text>
          </View>

          <View style={{ width: '100%' }}>
            <TouchableOpacity style={styles.doneBtn} onPress={onDone}>
              <Text style={styles.doneText}>Japa done</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.snoozeBtn} onPress={onSnooze}>
              <Text style={styles.snoozeText}>Snooze 5 min</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // 2) add / edit form
  if (adding || editingId) {
    const editingReminder = editingId ? reminders.find((x) => x.id === editingId) : null;
    return (
      <ReminderForm
        key={editingId || 'new'}
        initial={editingReminder}
        onSave={saveReminder}
        onCancel={() => {
          setAdding(false);
          setEditingId(null);
        }}
        onDelete={async () => {
          if (editingReminder) await remove(editingReminder);
          setEditingId(null);
        }}
      />
    );
  }

  // 3) home
  const upcoming = reminders
    .filter((r) => r.enabled && r.status === 'scheduled' && new Date(r.time).getTime() > Date.now())
    .sort((a, b) => new Date(a.time) - new Date(b.time))[0];

  const header = (
    <View>
      <View style={{ paddingTop: 76, paddingHorizontal: 4 }}>
        <Text style={styles.eyebrow}>NAAM JAPA</Text>
        <Text style={styles.homeTitle}>नाम जप</Text>
        <Text style={styles.homeSub}>Gentle nudges to return to the Name</Text>
      </View>

      <View style={styles.nextCard}>
        <View style={{ position: 'absolute', right: -10, bottom: -6, opacity: 0.18 }}>
          <Lotus width={130} fill={C.gold} edge={C.maroon} opacity={1} />
        </View>
        <Text style={styles.nextEyebrow}>NEXT JAPA</Text>
        {upcoming ? (
          <>
            <Text style={styles.nextTitle}>{upcoming.title}</Text>
            <Text style={styles.nextTime}>
              {formatTime(new Date(upcoming.time))} · {dayLabel(new Date(upcoming.time)).toLowerCase()}
            </Text>
            <View style={styles.nextPill}>
              <Text style={styles.nextPillText}>
                {upcoming.repeatMin > 0
                  ? `Repeats every ${upcoming.repeatMin} min for ${durText(upcoming.durationMin)}`
                  : 'Once'}
              </Text>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.nextTitle}>Nothing scheduled</Text>
            <Text style={styles.nextTime}>Tap + to set your next japa</Text>
          </>
        )}
      </View>

      <Text style={styles.sectionTitle}>Your japa</Text>

      <TouchableOpacity
        activeOpacity={1}
        onPress={() => setBloomKey((n) => n + 1)}
        style={{ position: 'absolute', top: 34, right: -40 }}
      >
        <BloomLotus key={bloomKey} width={190} />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <Gradient
        colors={['#F6C07A', '#FADDB4', '#FBF4E6']}
        height={330}
        style={{ position: 'absolute', top: 0, left: 0, right: 0 }}
      />
      <FlatList
        data={reminders}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={header}
        ListEmptyComponent={<Text style={styles.empty}>No japa reminders yet.</Text>}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 130 }}
        renderItem={({ item }) => {
          const dim = !item.enabled;
          return (
            <View style={[styles.card, dim && styles.cardDim]}>
              <View style={[styles.iconCircle, dim && { backgroundColor: '#EDE0C6' }]}>
                <Lotus
                  width={30}
                  fill={dim ? '#B9A582' : C.saffron}
                  edge={dim ? C.muted : '#A8500A'}
                  opacity={1}
                />
              </View>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => setEditingId(item.id)}>
                <Text style={[styles.cardTitle, dim && { color: '#5E4337' }]}>{item.title}</Text>
                <Text style={styles.cardSub}>{statusText(item)}</Text>
                <Text style={styles.cardSub}>{repeatText(item)}</Text>
              </TouchableOpacity>
              <Switch
                value={item.enabled}
                onValueChange={(v) => toggle(item, v)}
                trackColor={{ false: '#E3D3B3', true: C.saffron }}
                thumbColor="#FFF9EE"
                ios_backgroundColor="#E3D3B3"
              />
            </View>
          );
        }}
      />
      <TouchableOpacity style={styles.fab} onPress={() => setAdding(true)}>
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------- styles ----------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.ivory },
  row: { flexDirection: 'row', alignItems: 'center' },

  // home
  eyebrow: { fontSize: 12, fontFamily: F.sansBold, letterSpacing: 2.4, color: C.eyebrow },
  homeTitle: { fontFamily: F.deva, fontSize: 42, color: C.maroon, lineHeight: 64 },
  homeSub: { fontFamily: F.serifItalic, fontSize: 17, color: '#6B3F2F' },
  nextCard: {
    marginTop: 22,
    padding: 22,
    borderRadius: 24,
    backgroundColor: C.maroon,
    overflow: 'hidden',
    shadowColor: C.maroon,
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  nextEyebrow: { fontSize: 12, fontFamily: F.sansBold, letterSpacing: 2.2, color: C.gold },
  nextTitle: { marginTop: 6, fontFamily: F.serif, fontSize: 28, color: C.cream },
  nextTime: { marginTop: 6, fontSize: 16, color: '#F3D9B8' },
  nextPill: {
    marginTop: 12,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(233,193,119,0.18)',
  },
  nextPillText: { fontSize: 13, fontFamily: F.sansSemi, color: '#FFE8BF' },
  sectionTitle: { marginTop: 26, marginBottom: 14, fontFamily: F.serif, fontSize: 24, color: C.maroon },
  empty: { color: C.muted, fontSize: 15 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginBottom: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  cardDim: { backgroundColor: '#F6EEDD' },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginRight: 14,
    backgroundColor: '#FBE3C0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontFamily: F.serif, fontSize: 20, color: C.text },
  cardSub: { marginTop: 2, fontSize: 13, color: C.muted },
  fab: {
    position: 'absolute',
    right: 24,
    bottom: 34,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: C.saffron,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#A0500A',
    shadowOpacity: 0.38,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 8 },
  },
  fabText: { color: C.text, fontSize: 36, marginTop: -3 },

  // form
  form: { paddingHorizontal: 24, paddingTop: 52, paddingBottom: 50 },
  cancelBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  cancelText: { fontSize: 16, fontFamily: F.sansBold, color: C.eyebrow },
  formTitle: { fontFamily: F.serif, fontSize: 38, color: C.maroon },
  formSub: { fontFamily: F.serifItalic, fontSize: 17, color: '#6B3F2F', marginBottom: 6 },
  label: { marginTop: 22, marginBottom: 8, fontSize: 13, fontFamily: F.sansBold, letterSpacing: 1.8, color: C.eyebrow },
  input: {
    height: 54,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: C.chipBorder,
    borderRadius: 16,
    backgroundColor: C.card,
    fontSize: 18,
    fontFamily: F.sansSemi,
    color: C.text,
  },
  whenCard: {
    padding: 18,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  bigTime: { fontFamily: F.serif, fontSize: 60, color: C.maroon },
  ampm: {
    minWidth: 64,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.chipBorder,
    backgroundColor: C.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ampmActive: { backgroundColor: C.maroon, borderColor: C.maroon },
  ampmText: { fontSize: 16, fontFamily: F.sansBold, color: C.text },
  dateText: { marginTop: 10, fontSize: 15, color: C.muted },
  stepGrid: { marginTop: 14, flexDirection: 'row', flexWrap: 'wrap' },
  stepper: { width: '50%', marginBottom: 12 },
  stepperLabel: { fontSize: 13, fontFamily: F.sansSemi, color: C.muted, marginBottom: 6 },
  stepBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    marginRight: 8,
    borderWidth: 1,
    borderColor: C.chipBorder,
    backgroundColor: C.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: { fontSize: 26, fontFamily: F.sansSemi, color: C.text, marginTop: -2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    minHeight: 44,
    paddingHorizontal: 16,
    marginRight: 8,
    marginBottom: 8,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.chipBorder,
    backgroundColor: C.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: C.maroon, borderColor: C.maroon },
  chipText: { fontSize: 16, fontFamily: F.sansSemi, color: C.text },
  chipTextActive: { color: C.cream },
  wallCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  thumb: { width: 92, height: 120, borderRadius: 14, marginRight: 14, overflow: 'hidden' },
  wallHint: { fontSize: 14, lineHeight: 20, color: '#6E4B3F' },
  outlineBtn: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#A8500A',
    backgroundColor: C.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineBtnText: { fontSize: 15, fontFamily: F.sansBold, color: C.eyebrow },
  saveBtn: {
    marginTop: 28,
    height: 58,
    borderRadius: 29,
    backgroundColor: C.saffron,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#A0500A',
    shadowOpacity: 0.3,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 8 },
  },
  saveText: { fontSize: 19, fontFamily: F.sansBold, color: C.text },
  hint: { marginTop: 10, textAlign: 'center', fontSize: 13, color: '#6E4B3F' },

  // alert
  alertWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 74,
    paddingBottom: 56,
    paddingHorizontal: 24,
  },
  alertCaption: { fontSize: 13, fontFamily: F.sansBold, letterSpacing: 2.8, color: '#F3D9B8' },
  alertName: {
    fontFamily: F.deva,
    color: C.cream,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.2)',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 1 },
  },
  alertTitle: {
    marginTop: 18,
    fontFamily: F.serif,
    fontSize: 32,
    color: C.cream,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 2 },
  },
  alertSub: {
    marginTop: 6,
    fontSize: 15,
    color: '#F3D9B8',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 1 },
  },
  doneBtn: {
    height: 64,
    borderRadius: 32,
    backgroundColor: '#F7D9A0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { fontSize: 20, fontFamily: F.sansBold, color: C.text },
  snoozeBtn: {
    marginTop: 12,
    height: 56,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: '#F7D9A0',
    backgroundColor: 'rgba(30,11,43,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  snoozeText: { fontSize: 17, fontFamily: F.sansBold, color: C.cream },
});
