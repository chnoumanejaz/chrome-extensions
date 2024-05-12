document.addEventListener('DOMContentLoaded', function () {
  const apiKey = 'YOUR_API_KEY'; // Replace with your ExchangeRate-API key
  const convertBtn = document.getElementById('convertBtn');
  const resultContainer = document.getElementById('result');

  convertBtn.addEventListener('click', async function () {
    const amount = document.getElementById('amount').value;
    const fromCurrency = document.getElementById('fromCurrency').value;
    const toCurrency = document.getElementById('toCurrency').value;

    try {
      const response = await fetch(
        `https://v6.exchangeratesapi.io/latest?base=${fromCurrency}&symbols=${toCurrency}&apiKey=${apiKey}`
      );
      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      const rate = data.rates[toCurrency];
      const convertedAmount = amount * rate;
      resultContainer.textContent = `${amount} ${fromCurrency} = ${convertedAmount.toFixed(
        2
      )} ${toCurrency}`;
    } catch (error) {
      resultContainer.textContent = `Error: ${error.message}`;
    }
  });
});
