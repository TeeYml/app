import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  Canvas,
  Circle as SkiaCircle,
  LinearGradient as SkiaLinearGradient,
  Path as SkiaPath,
  Skia,
  vec,
} from "@shopify/react-native-skia";
import type { SkPath } from "@shopify/react-native-skia";
import {
  Easing,
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useTheme } from "../ThemeContext";
import { shadows } from "../theme";
import {
  buildMockPortfolioHistory,
  percentChange,
  resamplePoints,
  PortfolioPoint,
  Timeframe,
  TIMEFRAMES,
} from "../utils/portfolioHistory";

interface Props {
  balance: number;
}

/** Every timeframe is resampled to this many points so their Skia paths
 * always share the same vertex structure — required for `SkPath.interpolate`
 * to morph smoothly between timeframes instead of snapping. */
const SAMPLE_COUNT = 48;
const CHART_HEIGHT = 130;
const TOP_PADDING = 14;
const BOTTOM_PADDING = 10;
const TIMEFRAME_ANIMATION_MS = 450;

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Pixel Y for each sample, mapping its value into [TOP_PADDING, height - BOTTOM_PADDING]. */
function computePixelYs(samples: PortfolioPoint[], height: number): number[] {
  const values = samples.map((s) => s.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const usableHeight = height - TOP_PADDING - BOTTOM_PADDING;
  return values.map((v) => TOP_PADDING + usableHeight - ((v - min) / range) * usableHeight);
}

/** Smooth (Catmull-Rom -> cubic Bezier) wave path through fixed samples. */
function buildWavePath(samples: PortfolioPoint[], width: number, pixelYs: number[]): SkPath {
  const n = samples.length;
  const xAt = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * width);

  const path = Skia.Path.Make();
  path.moveTo(xAt(0), pixelYs[0]);

  for (let i = 0; i < n - 1; i++) {
    const p1x = xAt(i);
    const p1y = pixelYs[i];
    const p2x = xAt(i + 1);
    const p2y = pixelYs[i + 1];
    const p0y = pixelYs[Math.max(i - 1, 0)];
    const p0x = xAt(Math.max(i - 1, 0));
    const p3y = pixelYs[Math.min(i + 2, n - 1)];
    const p3x = xAt(Math.min(i + 2, n - 1));

    const cp1x = p1x + (p2x - p0x) / 6;
    const cp1y = p1y + (p2y - p0y) / 6;
    const cp2x = p2x - (p3x - p1x) / 6;
    const cp2y = p2y - (p3y - p1y) / 6;

    path.cubicTo(cp1x, cp1y, cp2x, cp2y, p2x, p2y);
  }

  return path;
}

function buildAreaPath(wavePath: SkPath, width: number, height: number): SkPath {
  const area = wavePath.copy();
  area.lineTo(width, height);
  area.lineTo(0, height);
  area.close();
  return area;
}

type PreparedTimeframe = {
  samples: PortfolioPoint[];
  path: SkPath;
  pixelYs: number[];
};

function prepareAllTimeframes(
  history: Record<Timeframe, PortfolioPoint[]>,
  width: number,
): Record<Timeframe, PreparedTimeframe> {
  const out = {} as Record<Timeframe, PreparedTimeframe>;
  for (const timeframe of TIMEFRAMES) {
    const samples = resamplePoints(history[timeframe], SAMPLE_COUNT);
    const pixelYs = computePixelYs(samples, CHART_HEIGHT);
    out[timeframe] = { samples, path: buildWavePath(samples, width, pixelYs), pixelYs };
  }
  return out;
}

const PortfolioChart: React.FC<Props> = ({ balance }) => {
  const { c } = useTheme();
  const [timeframe, setTimeframe] = useState<Timeframe>("1D");
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<PortfolioPoint | null>(null);

  const history = useMemo(() => buildMockPortfolioHistory(balance), [balance]);
  const prepared = useMemo(
    () => (width > 0 ? prepareAllTimeframes(history, width) : null),
    [history, width],
  );

  const latestPoint = history[timeframe][history[timeframe].length - 1];
  const change = percentChange(history[timeframe]);
  const isPositive = change >= 0;
  const trendColor = isPositive ? c.primary : c.destructive;

  // Two static paths (`from`/`to`) plus a `progress` shared value drive a
  // GPU-side morph between them on timeframe switches — no JS-thread work
  // once the animation starts.
  const fromPath = useSharedValue<SkPath | null>(null);
  const toPath = useSharedValue<SkPath | null>(null);
  const fromYs = useSharedValue<number[]>([]);
  const toYs = useSharedValue<number[]>([]);
  const progress = useSharedValue(1);

  const preparedRef = useRef<Record<Timeframe, PreparedTimeframe> | null>(null);
  preparedRef.current = prepared;

  useEffect(() => {
    if (!prepared) return;
    const current = prepared[timeframe];
    fromPath.value = current.path;
    toPath.value = current.path;
    fromYs.value = current.pixelYs;
    toYs.value = current.pixelYs;
    progress.value = 1;
    // Rebinding on `width`/`history` change (not `timeframe`) is intentional:
    // a resize or a fresh balance should snap to the current timeframe's new
    // geometry rather than re-animate from stale points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepared]);

  const handleTimeframePress = useCallback(
    (next: Timeframe) => {
      if (next === timeframe || !preparedRef.current) return;
      const target = preparedRef.current[next];
      fromPath.value = toPath.value ?? target.path;
      fromYs.value = toYs.value.length ? toYs.value : target.pixelYs;
      toPath.value = target.path;
      toYs.value = target.pixelYs;
      progress.value = 0;
      progress.value = withTiming(1, {
        duration: TIMEFRAME_ANIMATION_MS,
        easing: Easing.out(Easing.cubic),
      });
      setTimeframe(next);
    },
    [timeframe],
  );

  const animatedWavePath = useDerivedValue(() => {
    const from = fromPath.value;
    const to = toPath.value;
    if (!to) return Skia.Path.Make();
    if (!from || progress.value >= 1) return to;
    if (progress.value <= 0) return from;
    return to.interpolate(from, progress.value) ?? to;
  }, [progress]);

  const animatedAreaPath = useDerivedValue(() => {
    if (width === 0) return Skia.Path.Make();
    return buildAreaPath(animatedWavePath.value, width, CHART_HEIGHT);
  }, [animatedWavePath, width]);

  const gradientColors = useMemo(() => [trendColor + "40", trendColor + "00"], [trendColor]);

  // --- scrubbing ---
  const cursorX = useSharedValue(0);
  const cursorVisible = useSharedValue(0);
  const scrubIndex = useSharedValue(-1);

  const setScrubFromIndex = useCallback(
    (index: number) => {
      const samples = preparedRef.current?.[timeframe]?.samples;
      if (!samples) return;
      const clamped = Math.max(0, Math.min(samples.length - 1, index));
      setScrub(samples[clamped]);
    },
    [timeframe],
  );

  const clearScrub = useCallback(() => setScrub(null), []);

  useAnimatedReaction(
    () => Math.round(scrubIndex.value),
    (index, previous) => {
      if (index < 0) return;
      if (index !== previous) {
        runOnJS(setScrubFromIndex)(index);
      }
    },
    [timeframe],
  );

  const updateCursorFromX = (x: number) => {
    "worklet";
    if (width <= 0) return;
    const clampedX = Math.max(0, Math.min(width, x));
    cursorX.value = clampedX;
    scrubIndex.value = (clampedX / width) * (SAMPLE_COUNT - 1);
  };

  const pan = Gesture.Pan()
    // Activate immediately on touch-down rather than after a drag threshold:
    // a touch that starts on the chart is scrubbing, not scrolling the page.
    .minDistance(0)
    .onBegin((e) => {
      cursorVisible.value = withTiming(1, { duration: 120 });
      updateCursorFromX(e.x);
    })
    .onUpdate((e) => {
      updateCursorFromX(e.x);
    })
    .onFinalize(() => {
      cursorVisible.value = withTiming(0, { duration: 150 });
      scrubIndex.value = -1;
      runOnJS(clearScrub)();
    });

  const cursorY = useDerivedValue(() => {
    const fys = fromYs.value;
    const tys = toYs.value;
    if (fys.length === 0 || tys.length === 0) return 0;
    const idx = Math.max(0, Math.min(SAMPLE_COUNT - 1, cursorX.value / (width || 1) * (SAMPLE_COUNT - 1)));
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, SAMPLE_COUNT - 1);
    const frac = idx - i0;
    const yFrom = fys[i0] + (fys[i1] - fys[i0]) * frac;
    const yTo = tys[i0] + (tys[i1] - tys[i0]) * frac;
    return yFrom + (yTo - yFrom) * progress.value;
  }, [width]);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const displayValue = scrub ? scrub.value : latestPoint.value;
  const displayLabel = scrub ? scrub.label : null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border + "50" }, shadows.card]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.sub, { color: c.mutedForeground }]}>
            {displayLabel ?? "PORTFOLIO PERFORMANCE"}
          </Text>
          <Text style={[styles.value, { color: c.foreground }]}>{formatCurrency(displayValue)}</Text>
        </View>
        {!scrub && (
          <View style={[styles.badge, { backgroundColor: trendColor + "1A" }]}>
            <Text style={[styles.badgeText, { color: trendColor }]}>
              {isPositive ? "+" : ""}
              {change.toFixed(1)}% {timeframe}
            </Text>
          </View>
        )}
      </View>

      <GestureDetector gesture={pan}>
        <View style={styles.canvasWrap} onLayout={handleLayout}>
          {width > 0 && (
            <Canvas style={{ width, height: CHART_HEIGHT }}>
              <SkiaPath path={animatedAreaPath} style="fill">
                <SkiaLinearGradient start={vec(0, 0)} end={vec(0, CHART_HEIGHT)} colors={gradientColors} />
              </SkiaPath>
              <SkiaPath
                path={animatedWavePath}
                style="stroke"
                strokeWidth={3.5}
                strokeCap="round"
                strokeJoin="round"
                color={trendColor}
              />
              <SkiaCircle cx={cursorX} cy={cursorY} r={6} color={trendColor} opacity={cursorVisible} />
              <SkiaCircle
                cx={cursorX}
                cy={cursorY}
                r={6}
                color="#ffffff"
                style="stroke"
                strokeWidth={2}
                opacity={cursorVisible}
              />
            </Canvas>
          )}
        </View>
      </GestureDetector>

      <View style={styles.pillRow}>
        {TIMEFRAMES.map((tf) => {
          const active = tf === timeframe;
          return (
            <TouchableOpacity
              key={tf}
              onPress={() => handleTimeframePress(tf)}
              activeOpacity={0.7}
              style={[
                styles.pill,
                active && { backgroundColor: c.primary + "1A" },
              ]}
            >
              <Text style={[styles.pillText, { color: active ? c.primary : c.mutedForeground }]}>{tf}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: { borderRadius: 24, padding: 20, marginBottom: 28, borderWidth: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  sub: { fontSize: 10, fontWeight: "700", letterSpacing: 1.5 },
  value: { fontSize: 24, fontWeight: "800", marginTop: 4 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  canvasWrap: { height: CHART_HEIGHT, width: "100%" },
  pillRow: { flexDirection: "row", gap: 8, marginTop: 14, justifyContent: "flex-start" },
  pill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 12 },
  pillText: { fontSize: 12, fontWeight: "700" },
});

export default PortfolioChart;
