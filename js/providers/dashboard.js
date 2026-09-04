// js/dashboard.js - Lifecycle Manager за графики

const activeCharts = {};

export function renderChart(canvasId, chartConfig) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Унищожаваме съществуващата графика, ако има такава
  if (activeCharts[canvasId]) {
    activeCharts[canvasId].destroy();
    delete activeCharts[canvasId];
  }

  // Защита от NaN / Infinity в данните
  if (chartConfig.data && chartConfig.data.datasets) {
    chartConfig.data.datasets.forEach(dataset => {
      dataset.data = dataset.data.map(val => (isFinite(val) && !isNaN(val) ? val : 0));
    });
  }

  // Създаваме новата графика
  activeCharts[canvasId] = new Chart(canvas.getContext('2d'), chartConfig);
}
