import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/',          component: () => import('../pages/Overview.vue'),  meta: { title: 'Overview' } },
  { path: '/usage',     component: () => import('../pages/Usage.vue'),     meta: { title: 'Usage' } },
  { path: '/monitors',  component: () => import('../pages/Monitors.vue'),  meta: { title: 'Monitors' } },
  { path: '/cache',     component: () => import('../pages/Cache.vue'),     meta: { title: 'Cache' } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
