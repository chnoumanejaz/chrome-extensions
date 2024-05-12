document.addEventListener('DOMContentLoaded', function () {
  const toggleModeBtn = document.getElementById('toggleModeBtn');
  const body = document.body;

  const savedTheme = localStorage.getItem('currency_coverter_ext_theme');

  if (savedTheme === 'dark') {
    body.classList.add('dark');
    toggleModeBtn.textContent = 'Go Light';
  } else {
    toggleModeBtn.textContent = 'Go Dark';
  }

  toggleModeBtn.addEventListener('click', function () {
    body.classList.toggle('dark');

    if (body.classList.contains('dark')) {
      toggleModeBtn.textContent = 'Go Light';
      localStorage.setItem('currency_coverter_ext_theme', 'dark');
    } else {
      toggleModeBtn.textContent = 'Go Dark';
      localStorage.setItem('currency_coverter_ext_theme', 'light');
    }
  });

  let exchangeRates = {};
  const fromCurrency = document.getElementById('fromCurrency');
  const toCurrency = document.getElementById('toCurrency');
  const convertBtn = document.getElementById('convertBtn');
  const resultContainer = document.getElementById('result');

  resultContainer.textContent = '';
  fromCurrency.disabled = true;
  toCurrency.disabled = true;
  convertBtn.disabled = true;
  fromCurrency.classList.add('opacity-50', 'cursor-not-allowed');
  toCurrency.classList.add('opacity-50', 'cursor-not-allowed');
  convertBtn.classList.add('opacity-50', 'cursor-not-allowed');
  convertBtn.textContent = 'Loading Currencies...';

  fetch('https://www.floatrates.com/daily/usd.json')
    .then(response => response.json())
    .then(data => {
      exchangeRates = data;

      const sortedKeys = Object.keys(data).sort((a, b) => {
        const countryA = data[a].name.toLowerCase();
        const countryB = data[b].name.toLowerCase();
        return countryA.localeCompare(countryB);
      });

      sortedKeys.forEach((key, idx) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = `${data[key].name} (${key.toUpperCase()})`;

        fromCurrency.appendChild(option.cloneNode(true));
        toCurrency.appendChild(option);
      });

      // Set default selection of both source and destination using keys.
      fromCurrency.value = 'USD';
      toCurrency.value = 'pkr';
    })
    .catch(error => {
      resultContainer.style.color = 'red';
      resultContainer.style.fontWeight = 'bold';
      resultContainer.textContent = `Error: ${error.message}`;
    })
    .finally(() => {
      fromCurrency.disabled = false;
      toCurrency.disabled = false;
      fromCurrency.classList.remove('opacity-50', 'cursor-not-allowed');
      toCurrency.classList.remove('opacity-50', 'cursor-not-allowed');
      convertBtn.disabled = false;
      convertBtn.textContent = 'Convert Currency';
      convertBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    });

  convertBtn.addEventListener('click', async function () {
    const amount = document.getElementById('amount').value;
    const fromCurrencyVal = document.getElementById('fromCurrency').value;
    const toCurrencyVal = document.getElementById('toCurrency').value;

    try {
      resultContainer.style.color = 'black';
      resultContainer.style.fontWeight = 'normal';
      if (amount === '' || fromCurrencyVal === '' || toCurrencyVal === '') {
        throw new Error('Please fill all the fields to convert');
      }
      if (+amount <= 0 || isNaN(+amount)) {
        throw new Error('The amount must be Greater than 0.');
      }

      const convertedAmount = +amount * exchangeRates[toCurrencyVal].rate;

      resultContainer.textContent = `${amount} ${fromCurrencyVal} = ${formatCurrency(
        toCurrencyVal,
        convertedAmount
      )}`;
    } catch (error) {
      resultContainer.style.color = 'red';
      resultContainer.style.fontWeight = 'bold';
      resultContainer.textContent = `Error: ${error.message}`;
    }
  });

  function formatCurrency(currency, value) {
    const currencyLocales = {
      usd: 'en-US',
      eur: 'en-EU',
      gbp: 'en-GB',
      aud: 'en-AU',
      cad: 'en-CA',
      chf: 'de-CH',
      cny: 'zh-CN',
      jpy: 'ja-JP',
      krw: 'ko-KR',
      inr: 'en-IN',
      mxn: 'es-MX',
      brl: 'pt-BR',
      rub: 'ru-RU',
      zar: 'en-ZA',
      nzd: 'en-NZ',
      sek: 'sv-SE',
      dkk: 'da-DK',
      nok: 'nb-NO',
      sgd: 'en-SG',
      hkd: 'en-HK',
      thb: 'th-TH',
      try: 'tr-TR',
      idr: 'id-ID',
      myr: 'ms-MY',
      php: 'en-PH',
      pkr: 'ur-PK',
      aed: 'ar-AE',
      sar: 'ar-SA',
      qar: 'ar-QA',
      egp: 'ar-EG',
      ngn: 'ig-NG',
      kes: 'sw-KE',
      ghs: 'ak-GH',
      brl: 'pt-BR',
    };

    const locale = currencyLocales[currency.toLowerCase()] || 'en-US';

    const formattedValue = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(value);

    return formattedValue;
  }
});
