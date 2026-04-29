<template>
  <div class="auth-layout">
    <!-- Animated background -->
    <div class="auth-bg">
      <div class="auth-bg__grain" />
      <div class="auth-bg__glow auth-bg__glow--1" />
      <div class="auth-bg__glow auth-bg__glow--2" />
      <div class="auth-bg__glow auth-bg__glow--3" />
      <!-- Subtle paw prints scattered -->
      <svg
        v-for="i in 6"
        :key="i"
        class="auth-bg__paw"
        :style="pawStyle(i)"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <ellipse cx="12" cy="16" rx="5" ry="4.5" />
        <circle cx="7" cy="9" r="2.5" />
        <circle cx="17" cy="9" r="2.5" />
        <circle cx="4" cy="13" r="2" />
        <circle cx="20" cy="13" r="2" />
      </svg>
    </div>

    <div class="auth-content">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
function pawStyle(i: number) {
  const positions = [
    { top: '8%', left: '12%', rotate: '-25deg', opacity: 0.03, delay: '0s' },
    { top: '22%', right: '8%', rotate: '15deg', opacity: 0.025, delay: '2s' },
    { top: '55%', left: '5%', rotate: '-40deg', opacity: 0.02, delay: '4s' },
    { top: '75%', right: '15%', rotate: '30deg', opacity: 0.035, delay: '1s' },
    { top: '40%', right: '3%', rotate: '-10deg', opacity: 0.02, delay: '3s' },
    { top: '88%', left: '20%', rotate: '20deg', opacity: 0.03, delay: '5s' },
  ];
  const p = positions[i - 1];
  return {
    position: 'absolute' as const,
    ...p,
    transform: `rotate(${p.rotate})`,
    color: '#f59e0b',
    animationDelay: p.delay,
  };
}
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap');

.auth-layout {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  background: var(--bg-body);
  font-family: 'DM Sans', sans-serif;
}

.auth-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.auth-bg__grain {
  position: absolute;
  inset: 0;
  opacity: 0.035;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 256px;
}

.auth-bg__glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(120px);
  animation: glow-drift 20s ease-in-out infinite;
}

.auth-bg__glow--1 {
  width: 600px;
  height: 600px;
  top: -200px;
  right: -100px;
  background: radial-gradient(circle, rgba(217, 119, 6, 0.08) 0%, transparent 70%);
  animation-delay: 0s;
}

.auth-bg__glow--2 {
  width: 500px;
  height: 500px;
  bottom: -150px;
  left: -100px;
  background: radial-gradient(circle, rgba(180, 83, 9, 0.06) 0%, transparent 70%);
  animation-delay: -7s;
}

.auth-bg__glow--3 {
  width: 300px;
  height: 300px;
  top: 40%;
  left: 50%;
  background: radial-gradient(circle, rgba(245, 158, 11, 0.04) 0%, transparent 70%);
  animation-delay: -14s;
}

.auth-bg__paw {
  animation: paw-fade 8s ease-in-out infinite;
}

.auth-content {
  position: relative;
  z-index: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

@keyframes glow-drift {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(30px, -20px) scale(1.05); }
  66% { transform: translate(-20px, 15px) scale(0.95); }
}

@keyframes paw-fade {
  0%, 100% { opacity: 0; }
  50% { opacity: var(--paw-opacity, 0.03); }
}
</style>
