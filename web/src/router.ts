import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/LandingView.vue') },
    { path: '/join', component: () => import('./views/JoinView.vue') },
    { path: '/play', component: () => import('./views/PlayView.vue') },
    { path: '/screen', component: () => import('./views/ScreenView.vue') },
    { path: '/admin', component: () => import('./views/AdminView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

export default router
