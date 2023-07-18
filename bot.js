const { Web3 } = require("web3");
const ethers = require("ethers");
const networkInfo = require("./networkInfo.json");
const params = require("./params.json");
const routerAbi = require("./abi/RouterV2Abi.json");
const factoryAbi = require("./abi/FactoryV2Abi.json");
const tokenAbi = require("./abi/Erc20Abi.json");
const pairAbi = require("./abi/PairV2Abi.json");

const profitPercent = params.TPPercent;
const lossPercent = params.SLPercent;

const run = async (tokenAddress) => {
  const provider = new ethers.providers.WebSocketProvider(
    networkInfo[params.network].wss
  );
  let init = () => {};
  let routerAddress = networkInfo[params.network].router;
  let factoryAddress = networkInfo[params.network].factory;
  let wbnb = networkInfo[params.network].wbnbAddress;
  let busd = networkInfo[params.network].busdAddress;
  let routerSmartContract = new ethers.Contract(
    routerAddress,
    routerAbi,
    provider
  );
  const web3 = new Web3(networkInfo[params.network].wss);
  const factory = new ethers.Contract(factoryAddress, factoryAbi, provider);
  const router = new ethers.Contract(routerAddress, routerAbi, provider);

  let errInit = () => {
    provider.on("error", async (err) => {
      const RETRY_TIME = 1000;
      console.log(`------> ${tokenAddress} <------`);
      console.log(
        `${err}: Unable to connect, retrying in ${RETRY_TIME / 1000}s ...`
      );
      console.log("<------------------------------->");
      if (init) setTimeout(init, RETRY_TIME);
      else setTimeout(errInit, RETRY_TIME);
    });
  };
  errInit();
  let currentPrice = 0;
  var pairAddress;
  var pairContract;
  var hasPair = false;
  const getCurrentPrice = async (tokenAddress) => {
    let pricePerBNB = await router.getAmountsOut(
      web3.utils.toWei("1", "ether"),
      [tokenAddress, wbnb]
    );
    let BNBPrice = await router.getAmountsOut(web3.utils.toWei("1", "ether"), [
      wbnb,
      busd,
    ]);
    return ethers.BigNumber.from(pricePerBNB[1])
      .mul(ethers.BigNumber.from(BNBPrice[1]))
      .div(ethers.BigNumber.from(web3.utils.toWei("1", "ether")));
  };
  const fetchPairAddress = async (tokenAddress) => {
    const pairAddr = await factory.getPair(tokenAddress, wbnb);
    if (pairAddr == "0x0000000000000000000000000000000000000000") {
      currentPrice = 0;
      hasPair = false;
    } else {
      hasPair = true;
      pairAddress = pairAddr;
      console.log("Pair Address:", pairAddress);
      pairContract = new ethers.Contract(pairAddress, pairAbi, provider);
      startPairListener();
      currentPrice = await getCurrentPrice(tokenAddress);
      console.log(
        "Current Token Price: ",
        web3.utils.fromWei(currentPrice, "ether").toString()
      );
      buyToken(tokenAddress);
      // sellToken(tokenAddress);
    }
  };
  fetchPairAddress(tokenAddress);
  let wallets = [];
  if (provider) {
    wallets = params.privatekeys.map((key) => {
      return { key: key, handler: new ethers.Wallet(key, provider) };
    });
  }
  const getTokenBalance = async (tokenAddress, walletAddress) => {
    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider);
    const balance = await tokenContract.balanceOf(walletAddress);
    const decimal = await tokenContract.decimals();
    return web3.utils.fromWei(balance, "ether");
  };

  const buyToken = async (tokenAddress) => {
    console.log("Buy Transaction Generating....");
    for (var i = 0; i < wallets.length; i++) {
      sendBuyTransaction(tokenAddress, wallets[i].handler);
    }
    currentPrice = await getCurrentPrice(tokenAddress);
  };

  const sellToken = async (tokenAddress) => {
    console.log("Sell Transaction Generating....");
    for (var i = 0; i < wallets.length; i++) {
      sendSellTransaction(tokenAddress, wallets[i].handler);
    }
    currentPrice = await getCurrentPrice(tokenAddress);
  };

  const sendSellTransaction = async (tokenAddress, wallet) => {
    const walletBalance = await getTokenBalance(tokenAddress, wallet.address);
    console.log(walletBalance);
    if (walletBalance == 0) {
      console.log("There are not enough tokens");
      return;
    }
    const _router = routerSmartContract.connect(wallet);
    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, wallet);
    const allowance = await tokenContract.allowance(
      wallet.address,
      routerAddress
    );
    if (
      parseFloat(web3.utils.fromWei(allowance, "ether")) <
      parseFloat(walletBalance.toString())
    ) {
      await tokenContract.approve(
        routerAddress,
        "99999999999999999999999999999999"
      );
      console.log("Token Approved");
    }
    var amountOut = await _router.getAmountsOut(
      web3.utils.toWei(walletBalance, "ether"),
      [tokenAddress, wbnb]
    );
    if (amountOut[1] > 0) {
      var gasLimit = _router.estimateGas.swapExactTokensForETH(
        web3.utils.toWei(walletBalance, "ether"),
        amountOut[1].toString(),
        [tokenAddress, wbnb],
        wallet.address,
        parseInt(Date.now() / 1000) + 100
      );
      var gasPrice = await provider.getGasPrice();
      var data = await _router.populateTransaction.swapExactTokensForETH(
        web3.utils.toWei(walletBalance, "ether"),
        amountOut[1].toString(),
        [tokenAddress, wbnb],
        wallet.address,
        parseInt(Date.now() / 1000) + 100,
        {
          gasLimit: gasLimit,
          gasPrice: gasPrice,
        }
      );
      data = {
        ...data,
        nonce: await provider.getTransactionCount(wallet.address),
      };

      const tx = await wallet.sendTransaction(data);
      await tx.wait();
      const nativeBalance = await wallet.getBalance();
      console.log(`Sell Transaction Executed from ${wallet.address}`);
      console.log(`Tx hash: ${tx.hash}`);
      console.log(
        `Current Balance of Wallet: ${web3.utils
          .fromWei(nativeBalance, "ether")
          .toString()}`
      );
    } else {
      console.log("Insufficient Output Amount");
      console.log("Ignored the transactions");
    }
  };

  const sendBuyTransaction = async (tokenAddress, wallet) => {
    const walletBalance = await wallet.getBalance();
    if (walletBalance <= 0.005) {
      console.log(
        "There are no enough BNB in your wallet. Please deposit at least 0.005 BNB."
      );
      return;
    }
    const _router = routerSmartContract.connect(wallet);
    const buyAmount = params.buyAmount;
    var amountOut = await _router.getAmountsOut(
      web3.utils.toWei(buyAmount, "ether"),
      [wbnb, tokenAddress]
    );
    var gasLimit = await _router.estimateGas.swapETHForExactTokens(
      amountOut[1].toString(),
      [wbnb, tokenAddress],
      wallet.address,
      parseInt(Date.now() / 1000) + 100,
      {
        value: web3.utils.toWei(buyAmount, "ether"),
      }
    );
    var gasPrice = await provider.getGasPrice();
    var data = await _router.populateTransaction.swapETHForExactTokens(
      amountOut[1].toString(),
      [wbnb, tokenAddress],
      wallet.address,
      parseInt(Date.now() / 1000) + 100,
      {
        value: web3.utils.toWei(buyAmount, "ether"),
        gasPrice: gasPrice,
        gasLimit: gasLimit,
      }
    );
    data = {
      ...data,
      nonce: await provider.getTransactionCount(wallet.address),
    };

    const tx = await wallet.sendTransaction(data);
    await tx.wait();
    const tokenBalance = await getTokenBalance(tokenAddress, wallet.address);
    console.log(`Buy Transaction Executed from ${wallet.address}`);
    console.log(`Tx hash: ${tx.hash}`);
    console.log(
      `Current Balance of Token ${tokenAddress}: ${tokenBalance.toString()}`
    );
  };

  init = () => {
    if (!hasPair) {
      console.log("Creating Pair Listener Started!!!!");
      factory.on("PairCreated", async (token0, token1, addressPair) => {
        if (
          [token0.toLowerCase(), token1.toLowerCase()].includes(
            tokenAddress.toLowerCase()
          ) == true
        ) {
          console.log("Pair Creation is detected", addressPair);
          const pairRun = () => {
            pairAddress = addressPair.toLowerCase();
            pairContract = new ethers.Contract(pairAddress, pairAbi, provider);
            startPairListener();
            buyToken(tokenAddress);
            // sellToken(tokenAddress);
          };
          setTimeout(pairRun, 2000);
        }
      });
    }
  };

  const startPairListener = () => {
    if (pairContract) {
      console.log("Pair Contract Listener Started");
      pairContract.on("Swap", async (...params) => {
        const price = await getCurrentPrice(tokenAddress);
        console.log("Price is", web3.utils.fromWei(price, "ether").toString());
        console.log("Price change: ", (price / currentPrice) * 100 - 100, "%");
        if ((price / currentPrice) * 100 - 100 >= profitPercent) {
          buyToken(tokenAddress);
        }
        if (100 - (price / currentPrice) * 100 >= lossPercent) {
          sellToken(tokenAddress);
        }
      });
    }
  };

  init();
};

module.exports = { run };
