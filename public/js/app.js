document.addEventListener("DOMContentLoaded", () => {
  const goAnalyze = document.querySelector("#goAnalyze");
  const goAnalyze2 = document.querySelector("#goAnalyze2");
  const goCompare = document.querySelector("#goCompare");
  const goCompare2 = document.querySelector("#goCompare2");

  const goToAnalyze = () => {
    alert("Aquí irá la vista: Analizar un candidato");
  };

  const goToCompare = () => {
    alert("Aquí irá la vista: Comparar candidatos");
  };

  if (goAnalyze) goAnalyze.addEventListener("click", goToAnalyze);
  if (goAnalyze2) goAnalyze2.addEventListener("click", goToAnalyze);
  if (goCompare) goCompare.addEventListener("click", goToCompare);
  if (goCompare2) goCompare2.addEventListener("click", goToCompare);
});

