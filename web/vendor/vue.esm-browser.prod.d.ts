/**
 * web/vendor/vue.esm-browser.prod.js 的类型声明。
 *
 * 前端不用打包器，浏览器直接用相对路径加载这个 vendored 的 Vue 浏览器版构建
 * （含模板编译器，因此可以用 template 字符串写组件）。
 * 这里把它的类型指向 node_modules 里 vue 包自带的声明，TS 校验与运行时保持一致。
 */
export * from 'vue';
