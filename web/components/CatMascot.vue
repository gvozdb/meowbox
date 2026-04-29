<template>
  <div class="cat-mascot" :class="{ 'cat-mascot--blink': isBlinking }">
    <svg
      :width="size"
      :height="size"
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <!-- Cat body / head -->
      <g class="cat-head">
        <!-- Ears -->
        <path
          d="M30 52 L22 20 L45 40 Z"
          :fill="earFill"
          stroke="currentColor"
          stroke-width="2"
          class="cat-ear cat-ear--left"
        />
        <path
          d="M90 52 L98 20 L75 40 Z"
          :fill="earFill"
          stroke="currentColor"
          stroke-width="2"
          class="cat-ear cat-ear--right"
        />
        <!-- Inner ears -->
        <path d="M32 47 L27 27 L43 42 Z" :fill="innerEarFill" opacity="0.6" />
        <path d="M88 47 L93 27 L77 42 Z" :fill="innerEarFill" opacity="0.6" />

        <!-- Head shape -->
        <ellipse
          cx="60"
          cy="62"
          rx="34"
          ry="30"
          :fill="bodyFill"
          stroke="currentColor"
          stroke-width="2"
        />

        <!-- Eyes -->
        <g class="cat-eyes">
          <!-- Left eye -->
          <ellipse
            class="cat-eye"
            cx="47"
            cy="58"
            rx="7"
            ry="7.5"
            :fill="eyeBgFill"
          />
          <ellipse
            class="cat-pupil"
            cx="47"
            cy="58"
            :rx="pupilRx"
            ry="7"
            fill="#0a0a0f"
          />
          <circle cx="44" cy="55" r="2" fill="white" opacity="0.8" />

          <!-- Right eye -->
          <ellipse
            class="cat-eye"
            cx="73"
            cy="58"
            rx="7"
            ry="7.5"
            :fill="eyeBgFill"
          />
          <ellipse
            class="cat-pupil"
            cx="73"
            cy="58"
            :rx="pupilRx"
            ry="7"
            fill="#0a0a0f"
          />
          <circle cx="70" cy="55" r="2" fill="white" opacity="0.8" />

          <!-- Blink overlay -->
          <g v-if="isBlinking" class="cat-blink">
            <ellipse cx="47" cy="58" rx="8" ry="8.5" :fill="bodyFill" />
            <line x1="39" y1="58" x2="55" y2="58" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <ellipse cx="73" cy="58" rx="8" ry="8.5" :fill="bodyFill" />
            <line x1="65" y1="58" x2="81" y2="58" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </g>
        </g>

        <!-- Nose -->
        <path
          d="M58 67 L60 70 L62 67 Z"
          fill="#e8a0a0"
          stroke="#d48a8a"
          stroke-width="0.5"
        />

        <!-- Mouth -->
        <path
          d="M55 72 Q60 76 60 72"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          fill="none"
        />
        <path
          d="M60 72 Q60 76 65 72"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          fill="none"
        />

        <!-- Whiskers -->
        <g class="cat-whiskers" opacity="0.5">
          <line x1="20" y1="62" x2="38" y2="66" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          <line x1="18" y1="68" x2="37" y2="69" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          <line x1="22" y1="74" x2="38" y2="72" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          <line x1="82" y1="66" x2="100" y2="62" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          <line x1="83" y1="69" x2="102" y2="68" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          <line x1="82" y1="72" x2="98" y2="74" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
        </g>
      </g>

      <!-- Box (cardboard) -->
      <g class="cat-box">
        <rect
          x="25"
          y="78"
          width="70"
          height="35"
          rx="3"
          fill="#92400e"
          stroke="#78350f"
          stroke-width="2"
        />
        <!-- Box flaps -->
        <path
          d="M25 78 L35 70 L60 78"
          fill="#a16207"
          stroke="#78350f"
          stroke-width="1.5"
        />
        <path
          d="M60 78 L85 70 L95 78"
          fill="#a16207"
          stroke="#78350f"
          stroke-width="1.5"
        />
        <!-- Box texture lines -->
        <line x1="40" y1="85" x2="80" y2="85" stroke="#78350f" stroke-width="0.8" opacity="0.4" />
        <line x1="55" y1="82" x2="55" y2="108" stroke="#78350f" stroke-width="0.8" opacity="0.3" />
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    size?: number;
    mood?: 'happy' | 'sleepy' | 'alert';
  }>(),
  { size: 120, mood: 'happy' },
);

const isBlinking = ref(false);

const bodyFill = computed(() => '#f59e0b');
const earFill = computed(() => '#f59e0b');
const innerEarFill = computed(() => '#fbbf24');
const eyeBgFill = computed(() => '#fef3c7');

const pupilRx = computed(() => {
  if (props.mood === 'sleepy') return 2;
  if (props.mood === 'alert') return 5;
  return 3;
});

let blinkInterval: ReturnType<typeof setInterval>;

onMounted(() => {
  blinkInterval = setInterval(() => {
    isBlinking.value = true;
    setTimeout(() => {
      isBlinking.value = false;
    }, 150);
  }, 3000 + Math.random() * 2000);
});

onUnmounted(() => {
  clearInterval(blinkInterval);
});
</script>

<style scoped>
.cat-mascot {
  color: #92400e;
  display: inline-flex;
  filter: drop-shadow(0 4px 24px rgba(245, 158, 11, 0.15));
  animation: cat-float 4s ease-in-out infinite;
}

.cat-ear--left {
  transform-origin: 35px 40px;
  animation: ear-twitch-left 5s ease-in-out infinite;
}

.cat-ear--right {
  transform-origin: 85px 40px;
  animation: ear-twitch-right 7s ease-in-out infinite;
}

.cat-whiskers {
  animation: whisker-twitch 4s ease-in-out infinite;
}

@keyframes cat-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

@keyframes ear-twitch-left {
  0%, 90%, 100% { transform: rotate(0); }
  93% { transform: rotate(-5deg); }
  96% { transform: rotate(0); }
}

@keyframes ear-twitch-right {
  0%, 88%, 100% { transform: rotate(0); }
  91% { transform: rotate(5deg); }
  94% { transform: rotate(0); }
}

@keyframes whisker-twitch {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(1px); }
}
</style>
