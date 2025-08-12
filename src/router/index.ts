import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'viewer',
    component: () => import('../views/Viewer.vue'),
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router


