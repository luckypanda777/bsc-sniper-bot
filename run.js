let csvToJson = require("convert-csv-to-json");
const { run } = require("./bot");

let json = csvToJson.getJsonFromCsv("./list.csv");
for (let i = 0; i < json.length; i++) {
  run(json[i]["address"].toLowerCase());
}
