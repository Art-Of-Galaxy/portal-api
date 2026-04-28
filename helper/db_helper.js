const polls = require('../config/dbconfig');

function get_db_connection(req) {
    return new Promise(async (resolve, reject) => {
        let db_poll = polls.poll;
        resolve(db_poll);
    })
}
//get aws bucket name from env variable
// function get_aws_bucket_name(req) {
//     return new Promise(async (resolve, reject) => {
//         let aws_bucket_name = process.env.AWS_BUCKETNAME;
//         resolve(aws_bucket_name);
//     })
// }

module.exports = {
    get_db_connection,
};
