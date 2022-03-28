### Event-Analyzer-Line-MES

- This Event Analyzer is required to process the PLC data and do traceability, cycletime, downtime.

### Pre-Requisite
- node version > 10
- socketwebhook
- kafka

### Default Element List
- checkin ( Check In )
- checkout ( Check Out )
- partstatus ( Part Status )
- rework ( Rework )

### Query Elements
- substation
- order
- orderproduct
- orderrecipe
- orderroadmap
- checkin
- checkout
- component
- partstatus
- rework

### Functionality
1. Checkin
		- Check Main ID
		- Check Order
		- Check ProductTypeName
		- Check RoadMap ( except Init Station )
		- Check RecipeName
		- Check Normal OverallResult of Part Status element
2. Checkout
		- Check Main ID and substation result
		- Check Last station has Main Id or not. If not for Init station create fresh entry. For other station follow below steps
		- Check Overall Result
		- Overall Result is OK
		- Check Pre Stations already processed or not
		- If Yes then release otherwise bypass

3. PLC Live
		- write toggle to PLC for PLC and server is live or not (i.e. 1 or 0)
		- write 1 every 1 second to PLC.
		
4. SubAssemblyCheck
		- Check the main Id already proccessed properly in last station of subline and that station is connected to main line.
		- Get the process parameters of subline and write those to main line substation where subline is connected.

### Deployment 
1. Install debian using below command
	sudo dpkg -i <debian name>

2. Configure the Event analyzer for each substation using ansible script
	- For this refer ansbile
	- Need to do this when we deploy the line first time and If any changes done in Line Id, Subline Id, Substation Id.
	- Refer README.md file for configuration and refer the steps to enable and start Event Analyzer.
3. Credentials for authentication is hardcoded in E.A. So it should be always same for every deployment

### Webhook Table Configuration               
- This is configuration required for listening the **Operation** done on parameters using **Parameter Configuration UI**
**Here,** 
  **localhost**- IP Address of server where Socket Webhook is running

|webhook_url   |callback_type   |customer_id   |element_id  |
| ------------ | ------------ | ------------ | ------------ |
|http://localhost:10190/update/parameters   |2   |customer_id   |element_id ( parameters )   |
|http://localhost:10190/update/parameters   |3   |customer_id   |element_id ( parameters )  |
|http://localhost:10190/update/parameters   |4   |customer_id   |element_id ( parameters )   |
|http://localhost:10190/update/parameters    |8   |customer_id   |element_id ( parameters )  |
|http://localhost:10190/update/order   |2   |customer_id   |element_id ( order )   |
|http://localhost:10190/update/order   |3   |customer_id   |element_id ( order )  |
|http://localhost:10190/update/substation   |2   |customer_id   |element_id ( substation )   |
|http://localhost:10190/update/substation   |3   |customer_id   |element_id ( substation )  |

Query to write enter the webhook entry

		insert into webhook (id, webhook_url, callback_type, customer_id, element_id) values (1, 'http://<serverIP>:10190/update/order', 2, <customer_id>, <element_id>); 
		insert into webhook (id, webhook_url, callback_type, customer_id, element_id) values (2, 'http://<serverIP>:10190/update/order', 3, <customer_id>, <element_id>); 
		insert into webhook (id, webhook_url, callback_type, customer_id, element_id) values (3, 'http://<serverIP>:10190/update/parameters', 2, <customer_id>, <element_id>); 
		insert into webhook (id, webhook_url, callback_type, customer_id, element_id) values (4, 'http://<serverIP>:10190/update/parameters', 3, <customer_id>, <element_id>); 
		insert into webhook (id, webhook_url, callback_type, customer_id, element_id) values (5, 'http://<serverIP>:10190/update/parameters', 4, <customer_id>, <element_id>); 
		insert into webhook (id, webhook_url, callback_type, customer_id, element_id) values (6, 'http://<serverIP>:10190/update/parameters', 8, <customer_id>, <element_id>);
		insert into webhook (id, webhook_url, callback_type, customer_id, element_id) values (7, 'http://<serverIP>:10190/update/substation', 2, <customer_id>, <element_id>);
		insert into webhook (id, webhook_url, callback_type, customer_id, element_id) values (8, 'http://<serverIP>:10190/update/substation', 3, <customer_id>, <element_id>);

#### Webhook Callback Types

| Operation  |Callback_type  |
| ------------ | ------------ |
|Write   |2   |
|Update   |3   |
|Delete   |4   |
|Upload   |8   |